import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' 
    ? { rejectUnauthorized: false } 
    : false
});

// Hash function for user IDs (kept for migration purposes)
function hashUserId(userId) {
  return crypto.createHash('sha256').update(userId.toString()).digest('hex');
}

// Check if a value is a hash (64 hex chars) vs a Discord snowflake (17-19 digits)
function isHashedUserId(value) {
  // Hashed IDs are 64 character hex strings (contains letters a-f)
  // Discord snowflakes are 17-19 digit numbers (only digits)
  return value && value.length === 64 && /[a-f]/.test(value);
}

// Migration helper: Update all rows with hashed user_id to plain user_id
async function migrateUserIdFromHash(client, userId, logger) {
  const userIdHash = hashUserId(userId);
  
  // Check if any rows exist with this hash
  const checkResult = await client.query(
    'SELECT COUNT(*) as count FROM wordle_results WHERE user_id_hash = $1',
    [userIdHash]
  );
  
  const count = parseInt(checkResult.rows[0].count);
  if (count === 0) {
    return 0; // No rows to migrate
  }
  
  if (logger) {
    logger.info({ userId, count }, 'Found rows with hashed ID, migrating');
  }
  
  // Update all rows from hash to plain ID
  // We need to handle conflicts carefully - if the plain ID already exists, keep it
  const result = await client.query(`
    UPDATE wordle_results
    SET user_id_hash = $1
    WHERE user_id_hash = $2
      AND NOT EXISTS (
        SELECT 1 FROM wordle_results wr2 
        WHERE wr2.user_id_hash = $1 
          AND wr2.wordle_number = wordle_results.wordle_number
          AND wr2.channel_id = wordle_results.channel_id
      )
  `, [userId.toString(), userIdHash]);
  
  const updated = result.rowCount;
  if (logger) {
    logger.info({ userId, updated }, 'Migrated rows from hash to plain ID');
  }
  
  // Clean up any remaining hashed rows (these are duplicates)
  const deleteResult = await client.query(
    'DELETE FROM wordle_results WHERE user_id_hash = $1',
    [userIdHash]
  );
  
  if (deleteResult.rowCount > 0 && logger) {
    logger.info({ userId, removed: deleteResult.rowCount }, 'Removed duplicate hashed rows');
  }
  
  return updated;
}

// Save wordle results to database
// scores format: { 
//   wordleNumber: [
//     { userId, score, messageId },
//     ...
//   ]
// }
// channelId: Discord channel snowflake ID (string or number)
export async function saveWordleResults(scores, channelId, logger) {
  const log = logger ? logger.child({ function: 'saveWordleResults', channelId }) : null;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // First, check if any users need migration
    const userIds = [...new Set(
      Object.values(scores).flat().map(entry => entry.userId)
    )];
    
    if (log) {
      log.debug({ userCount: userIds.length }, 'Checking for user migrations');
    }
    
    for (const userId of userIds) {
      await migrateUserIdFromHash(client, userId, log);
    }
    
    const insertQuery = `
      INSERT INTO wordle_results (user_id_hash, wordle_number, completed_at, score, channel_id, message_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id_hash, wordle_number, channel_id) 
      DO UPDATE SET 
        score = EXCLUDED.score,
        completed_at = EXCLUDED.completed_at,
        message_id = COALESCE(EXCLUDED.message_id, wordle_results.message_id)
      RETURNING (xmax = 0) AS inserted
    `;
    
    let insertCount = 0;
    let newCount = 0;
    let updatedCount = 0;
    
    for (const [wordleNumber, dayResults] of Object.entries(scores)) {
      const completedAt = new Date(); // Use current timestamp
      
      for (const entry of dayResults) {
        const result = await client.query(insertQuery, [
          entry.userId.toString(), // Store user ID as plain string (not hashed)
          parseInt(wordleNumber),
          completedAt,
          entry.score,
          channelId.toString(), // Discord snowflakes as strings to avoid precision loss
          entry.messageId ? entry.messageId.toString() : null
        ]);
        
        insertCount++;
        
        // Check if this was a new insert or an update
        if (result.rows[0].inserted) {
          newCount++;
        } else {
          updatedCount++;
        }
      }
    }
    
    await client.query('COMMIT');
    
    if (log) {
      log.info({ total: insertCount, new: newCount, updated: updatedCount }, 'Saved wordle results to database');
    }
    
    return { total: insertCount, new: newCount, updated: updatedCount };
  } catch (error) {
    await client.query('ROLLBACK');
    if (log) {
      log.error({ err: error }, 'Error saving wordle results');
    }
    throw error;
  } finally {
    client.release();
  }
}

// Get wordle results from database
// Returns: { wordleNumber: [{ userId, score, channelId }], ... }
// NOTE: May contain duplicates (same userId + wordleNumber in different channels)
// Use deduplicateScores() helper to remove duplicates with channel priority
// channelId: optional filter by specific channel (null = all channels, '0' = legacy data)
export async function getWordleResults(userIds = null, startNumber = null, endNumber = null, channelId = null, logger) {
  const log = logger ? logger.child({ function: 'getWordleResults', channelId }) : null;
  const client = await pool.connect();
  
  try {
    let query = `
      SELECT user_id_hash, wordle_number, score, channel_id, message_id
      FROM wordle_results
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;
    
    // Filter by channel ID if provided
    if (channelId !== null) {
      query += ` AND channel_id = $${paramCount}`;
      params.push(channelId.toString());
      paramCount++;
    }
    
    // Filter by user IDs if provided
    if (userIds && userIds.length > 0) {
      // Build OR condition for both plain IDs and their hashes
      const userIdStrings = userIds.map(id => id.toString());
      const userIdHashes = userIds.map(id => hashUserId(id));
      const allPossibleIds = [...userIdStrings, ...userIdHashes];
      
      query += ` AND user_id_hash = ANY($${paramCount})`;
      params.push(allPossibleIds);
      paramCount++;
    }
    
    // Filter by wordle number range if provided
    if (startNumber) {
      query += ` AND wordle_number >= $${paramCount}`;
      params.push(startNumber);
      paramCount++;
    }
    
    if (endNumber) {
      query += ` AND wordle_number <= $${paramCount}`;
      params.push(endNumber);
      paramCount++;
    }
    
    query += ' ORDER BY wordle_number, user_id_hash';
    
    const result = await client.query(query, params);
    
    // Convert to the format needed by calculateLeaderboard
    const scores = {};
    
    for (const row of result.rows) {
      const wordleNumber = row.wordle_number.toString();
      
      if (!scores[wordleNumber]) {
        scores[wordleNumber] = [];
      }
      
      // Return in object format { userId, score, channelId, messageId }
      // If the user_id_hash is actually a hash, we'll keep it for now
      // (it will be migrated on next save)
      scores[wordleNumber].push({ 
        userId: row.user_id_hash,
        score: row.score,
        channelId: row.channel_id,
        messageId: row.message_id,
        isHashed: isHashedUserId(row.user_id_hash) // Flag for debugging
      });
    }
    
    if (log) {
      const channelInfo = channelId ? ` for channel ${channelId}` : '';
      log.info({ puzzleCount: Object.keys(scores).length, channelInfo }, 'Retrieved wordle results from database');
    }
    
    return scores;
  } catch (error) {
    if (log) {
      log.error({ err: error }, 'Error retrieving wordle results');
    }
    throw error;
  } finally {
    client.release();
  }
}

// Get all unique user IDs in the database (both plain and hashed)
// channelId: optional filter by specific channel
export async function getAllUserIds(channelId = null, logger) {
  const log = logger ? logger.child({ function: 'getAllUserIds', channelId }) : null;
  const client = await pool.connect();
  
  try {
    let query = 'SELECT DISTINCT user_id_hash FROM wordle_results';
    const params = [];
    
    if (channelId !== null) {
      query += ' WHERE channel_id = $1';
      params.push(channelId.toString());
    }
    
    const result = await client.query(query, params);
    
    if (log) {
      log.debug({ userCount: result.rows.length }, 'Retrieved user IDs');
    }
    
    return result.rows.map(row => row.user_id_hash);
  } catch (error) {
    if (log) {
      log.error({ err: error }, 'Error getting user IDs');
    }
    throw error;
  } finally {
    client.release();
  }
}

// Get detailed statistics for a specific user
// Deduplicates by (user_id, wordle_number) using channel priority
// channelId: optional preferred channel for deduplication (null = use lowest non-zero, then 0)
export async function getUserStats(userId, channelId = null, logger) {
  const log = logger ? logger.child({ function: 'getUserStats', userId, channelId }) : null;
  const client = await pool.connect();
  
  try {
    // First, try to migrate this user's data if it exists as hashed
    await migrateUserIdFromHash(client, userId, log);
    
    // Use DISTINCT ON to pick one row per wordle_number based on priority
    // Priority: 1) channelId (if provided), 2) lowest non-zero channel_id, 3) channel_id 0
    const channelPriority = channelId !== null ? `
      DISTINCT ON (wordle_number)
      wordle_number,
      score,
      channel_id,
      message_id,
      completed_at,
      CASE 
        WHEN channel_id = $2 THEN 1
        WHEN channel_id > 0 THEN 2
        ELSE 3
      END as priority
    ` : `
      DISTINCT ON (wordle_number)
      wordle_number,
      score,
      channel_id,
      message_id,
      completed_at,
      CASE 
        WHEN channel_id > 0 THEN 1
        ELSE 2
      END as priority
    `;
    
    const orderBy = channelId !== null ? `
      ORDER BY wordle_number, 
        CASE 
          WHEN channel_id = $2 THEN 1
          WHEN channel_id > 0 THEN 2
          ELSE 3
        END,
        channel_id
    ` : `
      ORDER BY wordle_number,
        CASE 
          WHEN channel_id > 0 THEN 1
          ELSE 2
        END,
        channel_id
    `;
    
    const params = channelId !== null ? [userId.toString(), channelId.toString()] : [userId.toString()];
    
    // Get deduplicated games for this user
    const deduplicatedGames = await client.query(
      `
      SELECT ${channelPriority}
      FROM wordle_results
      WHERE user_id_hash = $1
      ${orderBy}
      `,
      params
    );
    
    if (deduplicatedGames.rows.length === 0) {
      if (log) {
        log.info('No games found for user');
      }
      // No games found
      return {
        totalGames: 0,
        avgScore: 0,
        bestScore: 0,
        worstScore: 0,
        firstWordle: 0,
        lastWordle: 0,
        distribution: [],
        recent: []
      };
    }
    
    // Calculate stats from deduplicated data
    const scores = deduplicatedGames.rows.map(r => r.score);
    const totalGames = scores.length;
    const avgScore = scores.reduce((sum, s) => sum + s, 0) / totalGames;
    const bestScore = Math.min(...scores);
    const worstScore = Math.max(...scores);
    const firstWordle = Math.min(...deduplicatedGames.rows.map(r => r.wordle_number));
    const lastWordle = Math.max(...deduplicatedGames.rows.map(r => r.wordle_number));
    
    // Calculate distribution
    const distribution = {};
    for (const row of deduplicatedGames.rows) {
      distribution[row.score] = (distribution[row.score] || 0) + 1;
    }
    
    const distributionArray = Object.entries(distribution)
      .map(([score, count]) => ({ score: parseInt(score), count }))
      .sort((a, b) => a.score - b.score);
    
    // Get recent games (last 10)
    const recent = deduplicatedGames.rows
      .sort((a, b) => b.wordle_number - a.wordle_number)
      .slice(0, 10)
      .map(r => ({
        wordleNumber: r.wordle_number,
        score: r.score,
        channelId: r.channel_id,
        messageId: r.message_id
      }));
    
    if (log) {
      log.info({ totalGames, avgScore: parseFloat(avgScore.toFixed(2)), bestScore, worstScore }, 'Retrieved user stats');
    }
    
    return {
      totalGames,
      avgScore: parseFloat(avgScore.toFixed(2)),
      bestScore,
      worstScore,
      firstWordle,
      lastWordle,
      distribution: distributionArray,
      recent
    };
  } catch (error) {
    if (log) {
      log.error({ err: error }, 'Error getting user stats');
    }
    throw error;
  } finally {
    client.release();
  }
}

// Get all results from a specific message ID
// Returns array of all rows with that message_id (can be multiple users)
export async function getResultsByMessageId(messageId, logger) {
  const log = logger ? logger.child({ function: 'getResultsByMessageId', messageId }) : null;
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `
      SELECT user_id_hash, wordle_number, score, channel_id, message_id, completed_at
      FROM wordle_results
      WHERE message_id = $1
      ORDER BY user_id_hash
      `,
      [messageId.toString()]
    );
    
    if (log) {
      log.debug({ resultCount: result.rows.length }, 'Retrieved results by message ID');
    }
    
    return result.rows; // Returns array (can be empty, or have multiple rows)
  } catch (error) {
    if (log) {
      log.error({ err: error }, 'Error getting results by message ID');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}