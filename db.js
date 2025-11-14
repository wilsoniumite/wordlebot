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
export async function saveWordleResults(scores) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const insertQuery = `
      INSERT INTO wordle_results (user_id_hash, wordle_number, completed_at, score)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id_hash, wordle_number) 
      DO UPDATE SET 
        score = EXCLUDED.score,
        completed_at = EXCLUDED.completed_at
      RETURNING (xmax = 0) AS inserted
    `;
    
    let insertCount = 0;
    let newCount = 0;
    let updatedCount = 0;
    
    for (const [wordleNumber, dayResults] of Object.entries(scores)) {
      const completedAt = new Date(); // Use current timestamp
      
      for (const [userId, score] of dayResults) {
        const userIdHash = hashUserId(userId);
        
        const result = await client.query(insertQuery, [
          userIdHash,
          parseInt(wordleNumber),
          completedAt,
          score
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
    console.log(`Saved ${insertCount} wordle results to database (${newCount} new, ${updatedCount} updated)`);
    
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
// Returns in the same format as parseWordleResults: { wordleNumber: [[userId, score], ...], ... }
export async function getWordleResults(userIds = null, startNumber = null, endNumber = null) {
  const client = await pool.connect();
  
  try {
    let query = `
      SELECT user_id_hash, wordle_number, score
      FROM wordle_results
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;
    
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
    
    // Convert to the same format as parseWordleResults
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
      scores[wordleNumber].push([userId, row.score]);
    }
    
    console.log(`Retrieved results for ${Object.keys(scores).length} wordle puzzles from database`);
    
    return scores;
  } catch (error) {
    console.error('Error retrieving wordle results:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Get all unique user ID hashes in the database
export async function getAllUserIdHashes() {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'SELECT DISTINCT user_id_hash FROM wordle_results'
    );
    
    return result.rows.map(row => row.user_id_hash);
  } catch (error) {
    console.error('Error getting user ID hashes:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Get detailed statistics for a specific user
export async function getUserStats(userId) {
  const client = await pool.connect();
  
  try {
    const userIdHash = hashUserId(userId);
    
    // Get overall stats
    const overallResult = await client.query(
      `
      SELECT 
        COUNT(*) as total_games,
        ROUND(AVG(score), 2) as avg_score,
        MIN(score) as best_score,
        MAX(score) as worst_score,
        MIN(wordle_number) as first_wordle,
        MAX(wordle_number) as last_wordle
      FROM wordle_results
      WHERE user_id_hash = $1
      `,
      [userIdHash]
    );
    
    // Get score distribution
    const distributionResult = await client.query(
      `
      SELECT 
        score,
        COUNT(*) as count
      FROM wordle_results
      WHERE user_id_hash = $1
      GROUP BY score
      ORDER BY score
      `,
      [userIdHash]
    );
    
    // Get recent games (last 10)
    const recentResult = await client.query(
      `
      SELECT 
        wordle_number,
        score
      FROM wordle_results
      WHERE user_id_hash = $1
      ORDER BY wordle_number DESC
      LIMIT 10
      `,
      [userIdHash]
    );
    
    const overall = overallResult.rows[0];
    const distribution = distributionResult.rows;
    const recent = recentResult.rows;
    
    return {
      totalGames: parseInt(overall.total_games),
      avgScore: parseFloat(overall.avg_score),
      bestScore: parseInt(overall.best_score),
      worstScore: parseInt(overall.worst_score),
      firstWordle: parseInt(overall.first_wordle),
      lastWordle: parseInt(overall.last_wordle),
      distribution: distribution.map(d => ({ score: parseInt(d.score), count: parseInt(d.count) })),
      recent: recent.map(r => ({ wordleNumber: parseInt(r.wordle_number), score: parseInt(r.score) }))
    };
  } catch (error) {
    console.error('Error getting user stats:', error);
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}