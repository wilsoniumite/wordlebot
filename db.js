import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Hash function for user IDs
export function hashUserId(userId) {
  return crypto.createHash('sha256').update(userId.toString()).digest('hex');
}

// Save wordle results to database
// scores format: { 
//   wordleNumber: [
//     { userId, score, messageId },
//     ...
//   ]
// }
// channelId: Discord channel snowflake ID (string or number)
export async function saveWordleResults(scores, channelId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
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
        const userIdHash = hashUserId(entry.userId);
        
        const result = await client.query(insertQuery, [
          userIdHash,
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
    console.log(`Saved ${insertCount} wordle results to database (${newCount} new, ${updatedCount} updated) for channel ${channelId}`);
    
    return { total: insertCount, new: newCount, updated: updatedCount };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving wordle results:', error);
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
export async function getWordleResults(userIds = null, startNumber = null, endNumber = null, channelId = null) {
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
      const userIdHashes = userIds.map(id => hashUserId(id));
      query += ` AND user_id_hash = ANY($${paramCount})`;
      params.push(userIdHashes);
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
    const hashToUserId = {};
    
    // Build reverse mapping if userIds were provided
    if (userIds && userIds.length > 0) {
      for (const userId of userIds) {
        hashToUserId[hashUserId(userId)] = userId;
      }
    }
    
    for (const row of result.rows) {
      const wordleNumber = row.wordle_number.toString();
      
      if (!scores[wordleNumber]) {
        scores[wordleNumber] = [];
      }
      
      // Use the original userId if we have it in the mapping, otherwise use the hash
      const userId = hashToUserId[row.user_id_hash] || row.user_id_hash;
      
      // Return in object format { userId, score, channelId }
      // channelId is needed for deduplication
      scores[wordleNumber].push({ 
        userId, 
        score: row.score,
        channelId: row.channel_id 
      });
    }
    
    const channelInfo = channelId ? ` for channel ${channelId}` : '';
    console.log(`Retrieved results for ${Object.keys(scores).length} wordle puzzles from database${channelInfo}`);
    
    return scores;
  } catch (error) {
    console.error('Error retrieving wordle results:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Get all unique user ID hashes in the database
// channelId: optional filter by specific channel
export async function getAllUserIdHashes(channelId = null) {
  const client = await pool.connect();
  
  try {
    let query = 'SELECT DISTINCT user_id_hash FROM wordle_results';
    const params = [];
    
    if (channelId !== null) {
      query += ' WHERE channel_id = $1';
      params.push(channelId.toString());
    }
    
    const result = await client.query(query, params);
    
    return result.rows.map(row => row.user_id_hash);
  } catch (error) {
    console.error('Error getting user ID hashes:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Get detailed statistics for a specific user
// Deduplicates by (user_id_hash, wordle_number) using channel priority
// channelId: optional preferred channel for deduplication (null = use lowest non-zero, then 0)
export async function getUserStats(userId, channelId = null) {
  const client = await pool.connect();
  
  try {
    const userIdHash = hashUserId(userId);
    
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
    
    const params = channelId !== null ? [userIdHash, channelId.toString()] : [userIdHash];
    
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
    console.error('Error getting user stats:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Get all results from a specific message ID
// Returns array of all rows with that message_id (can be multiple users)
export async function getResultsByMessageId(messageId) {
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
    
    return result.rows; // Returns array (can be empty, or have multiple rows)
  } catch (error) {
    console.error('Error getting results by message ID:', error);
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}