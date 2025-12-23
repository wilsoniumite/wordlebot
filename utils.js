import sharp from 'sharp';
import Tesseract from 'tesseract.js';

// Utility functions for Elo calculations (based on utils.py)
function geometricMean(arr) {
  const logSum = arr.reduce((sum, val) => sum + Math.log(val), 0);
  return Math.exp(logSum / arr.length);
}

function computeNll(w, eloRatings) {
  const n = eloRatings.length;
  const numGames = w.reduce((sum, row) => sum + row.reduce((rowSum, val) => rowSum + val, 0), 0);
  let nll = 0.0;
  
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        // Pairwise probability
        const pIj = 1 / (1 + Math.pow(10, (eloRatings[j] - eloRatings[i]) / 400));
        
        // Add contributions to the NLL
        if (w[i][j] > 0) {
          nll -= w[i][j] * Math.log10(pIj);
        }
        if (w[j][i] > 0) {
          nll -= w[j][i] * Math.log10(1 - pIj);
        }
      }
    }
  }
  
  return nll / numGames;
}

function calcMapElos(w, tol = 1e-6) {
  // Get the MAP estimate of the Elo ratings according to newman 2023
  const n = w.length;
  let p = new Array(n).fill(1); // Initial guess for p
  const nlls = [];
  
  for (let iteration = 0; iteration < 200; iteration++) {
    const pOld = [...p];
    
    // Update each p_i
    for (let i = 0; i < n; i++) {
      let numerator = 1 / (p[i] + 1);
      let denominator = 1 / (p[i] + 1);
      
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          numerator += w[i][j] * p[j] / (p[i] + p[j]);
          denominator += w[j][i] / (p[i] + p[j]);
        }
      }
      
      p[i] = numerator / denominator;
    }
    
    // Normalize using geometric mean
    const geomMean = geometricMean(p);
    for (let i = 0; i < n; i++) {
      p[i] /= geomMean;
    }
    
    // Check for convergence
    const diff = pOld.reduce((sum, val, i) => sum + Math.abs(val - p[i]), 0);
    if (diff < tol) {
      break;
    }
    
    // Calculate Elo ratings for NLL computation
    const eloRatings = p.map(pVal => 1000 + 400 * Math.log10(pVal));
    nlls.push(computeNll(w, eloRatings));
  }
  
  const elos = p.map(pVal => 1000 + 400 * Math.log10(pVal));
  return { p, elos, nlls };
}

function calculateElo(elo0, elo1, sa, k) {
  const eloDiff = elo1 - elo0;
  const ea = 1 / (1 + Math.pow(10, eloDiff / 400));
  const eb = 1 - ea;
  const sb = 1 - sa;
  return [elo0 + k * (sa - ea), elo1 + k * (sb - eb)];
}

function points(a, b, maxScore = 6) {
  return 0.5 + (b - a) / (maxScore - 1) / 2;
}

export function calcEloIterated(scores, allPlayers, k = 2, maxScore = 6) {
  const numPlayers = allPlayers.length;
  const eloOverTime = [];
  
  // Initialize with starting Elos
  let currentElos = new Array(numPlayers).fill(1000);
  eloOverTime.push([...currentElos]);
  
  for (const day of scores) {
    // Copy previous day's Elos
    currentElos = [...currentElos];
    
    for (const [playerName, score] of day) {
      const playerIdx = allPlayers.indexOf(playerName);
      if (playerIdx === -1) continue;
      
      for (const [opponentName, opponentScore] of day) {
        if (playerName === opponentName) continue;
        
        const opponentIdx = allPlayers.indexOf(opponentName);
        if (opponentIdx === -1) continue;
        
        const sa = points(score, opponentScore, maxScore);
        const [newPlayerElo, newOpponentElo] = calculateElo(
          currentElos[playerIdx],
          currentElos[opponentIdx],
          sa,
          k
        );
        
        currentElos[playerIdx] = newPlayerElo;
        currentElos[opponentIdx] = newOpponentElo;
      }
    }
    
    eloOverTime.push([...currentElos]);
  }
  
  return eloOverTime;
}

async function handleRateLimitHeaders(response, context = '') {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const resetAfter = response.headers.get('x-ratelimit-reset-after');
  const limit = response.headers.get('x-ratelimit-limit');
  
  if (remaining !== null && limit !== null) {
    const remainingCount = parseInt(remaining);
    const limitCount = parseInt(limit);
    
    // If we're running low on requests, add a delay
    if (remainingCount <= 2 && remainingCount > 0) {
      const waitTime = resetAfter ? parseFloat(resetAfter) * 1000 : 1000;
      console.log(`[RateLimit] ${context}: ${remainingCount}/${limitCount} remaining, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// Function to fetch channel messages with rate limiting
export async function fetchChannelMessages(channelId, limit = 100) {
  const messages = [];
  let before = null;
  
  while (messages.length < limit) {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`;
    
    let retries = 0;
    const maxRetries = 3;
    let response;
    
    // Retry loop for handling rate limits
    while (retries <= maxRetries) {
      response = await fetch(url, {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const waitTime = retryAfter ? parseFloat(retryAfter) * 1000 : Math.pow(2, retries) * 1000;
        
        console.log(`Rate limited. Waiting ${waitTime}ms before retry ${retries + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
        continue;
      }
      
      if (!response.ok) {
        throw new Error(`Failed to fetch messages: ${response.status} ${response.statusText}`);
      }

      // Check rate limit headers
      await handleRateLimitHeaders(response, 'fetchChannelMessages');
      
      // Success - break out of retry loop
      break;
    }
    
    if (retries > maxRetries) {
      throw new Error('Max retries exceeded for fetching messages');
    }
    
    const batch = await response.json();
    if (batch.length === 0) break;
    
    messages.push(...batch);
    before = batch[batch.length - 1].id;
    
    if (batch.length < 100) break; // No more messages
    
    // Add a small delay between requests to avoid rate limiting
    // Discord recommends spacing out requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return messages;
}

// Function to fetch user info from Discord API
export async function fetchUserInfo(userId) {
  try {
    let retries = 0;
    const maxRetries = 3;
    let response;
    
    while (retries <= maxRetries) {
      response = await fetch(`https://discord.com/api/v10/users/${userId}`, {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      
      if (response.status === 429) {
        // Rate limited
        const retryAfter = response.headers.get('retry-after');
        const waitTime = retryAfter ? parseFloat(retryAfter) * 1000 : Math.pow(2, retries) * 1000;
        
        console.log(`Rate limited fetching user ${userId}. Waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
        continue;
      }
      
      break;
    }
    
    if (!response.ok) {
      console.warn(`Failed to fetch user ${userId}: ${response.status}`);
      return `User${userId.substring(0, 6)}`;
    }

    // Check rate limit headers
    await handleRateLimitHeaders(response, 'fetchUserInfo');
    
    const user = await response.json();
    // Prefer display name, fall back to username, then user ID
    return user.display_name || user.global_name || user.username || `User${userId.substring(0, 6)}`;
  } catch (error) {
    console.error(`Failed to fetch user ${userId}:`, error);
    return `User${userId.substring(0, 6)}`;
  }
}

// Filter out score 7 (failed attempts) if not counting them
export function filterScores(scores, xIsSeven) {
  if (xIsSeven) {
    // Include all scores including 7
    return scores;
  }
  
  // Filter out score 7 from each day
  const filteredScores = {};
  for (const [date, dayResults] of Object.entries(scores)) {
    const filtered = dayResults.filter(([userId, score]) => score !== 7);
    if (filtered.length > 0) {
      filteredScores[date] = filtered;
    }
  }
  
  return filteredScores;
}

// Build a mapping of nicknames to user IDs from guild members
async function buildUsernameMapping(guildId) {
  const usernameToUserId = {};
  
  try {
    // Fetch all guild members with retry logic
    console.log(`Fetching guild members for guild ${guildId}...`);
    
    let retries = 0;
    const maxRetries = 3;
    let response;
    
    while (retries <= maxRetries) {
      response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`, {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const waitTime = retryAfter ? parseFloat(retryAfter) * 1000 : Math.pow(2, retries) * 1000;
        
        console.log(`Rate limited fetching guild members. Waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
        continue;
      }
      
      break;
    }
    
    if (!response.ok) {
      console.error(`Failed to fetch guild members: ${response.status}`);
      return { usernameToUserId };
    }

    // Check rate limit headers
    await handleRateLimitHeaders(response, 'buildUsernameMapping');
    
    const members = await response.json();
    
    for (const member of members) {
      if (member.user.bot) continue; // Skip bots
      
      const userId = member.user.id;
      // Use nick (server nickname) if available, otherwise use global_name or username
      const displayName = member.nick || member.user.global_name || member.user.username;
      
      // Store lowercase for case-insensitive matching
      usernameToUserId[displayName.toLowerCase()] = userId;
    }
  } catch (error) {
    console.error('Error building username mapping:', error);
  }
  return { usernameToUserId };
}

// Extract Wordle number from image using OCR
async function extractWordleNumber(imageUrl) {
  try {
    
    // Fetch the image
    const response = await fetch(imageUrl);
    const buffer = await response.arrayBuffer();
    
    // Crop to just the top portion with "Wordle No. 1567"
    const cropped = await sharp(Buffer.from(buffer))
      .extract({
        left: 141,    // x position
        top: 0,       // y position
        width: 230,   // width of crop
        height: 40    // height of crop (just enough for the text)
      })
      .toBuffer();
    
    // OCR the cropped image
    const { data: { text } } = await Tesseract.recognize(cropped, 'eng', {
      logger: () => {} // Suppress verbose logs
    });
    
    // Extract number from text like "Wordle No. 1567" or "Wordle 1567"
    const match = text.match(/Wordle\s+(?:No\.?\s+)?(\d+)/i);
    
    if (match) {
      const wordleNumber = parseInt(match[1]);
      return wordleNumber;
    }
    
    console.warn(`  ✗ Could not extract Wordle number from image. Text found: ${text.substring(0, 100)}`);
    return null;
  } catch (error) {
    console.error(`  ✗ Error extracting Wordle number:`, error.message);
    return null;
  }
}

export async function parseWordleResults(messages, guildId) {
  // Build username to ID mapping from guild members
  const { usernameToUserId } = await buildUsernameMapping(guildId);
  
  const scores = {};
  
  for (const message of messages) {
    if (message.content && message.content.includes("Here are yesterday's results:")) {
      // Extract Wordle number from attached image
      const imageUrl = message.attachments?.[0]?.url;
      if (!imageUrl) {
        console.warn('Message has results but no image attachment, skipping');
        continue;
      }
      
      const wordleNumber = await extractWordleNumber(imageUrl);
      if (!wordleNumber) {
        console.warn('Could not extract Wordle number from image, skipping message');
        continue;
      }
      
      const lines = message.content.split('\n').slice(1);
      const dayResults = [];
      
      for (const line of lines) {
        if (!line.includes(':')) continue;
        
        let scoreStr = line.split(':')[0].replace('👑', '').replace('/6', '').trim();
        
        if (scoreStr === 'X') {
          scoreStr = '7';
        }
        
        const score = parseInt(scoreStr);
        if (isNaN(score) || score < 1 || score > 7) continue;
        
        // Get the part after the score
        const playersPart = line.split(':').slice(1).join(':'); // Handle multiple colons
        
        // Split by @ to get each mention
        const mentions = playersPart.split('@').slice(1); // Remove empty first element
        
        for (const mention of mentions) {
          let userId = null;
          
          // Clean up the mention - remove > and whitespace
          const cleaned = mention.replace('>', '').trim();
          
          // Check if it's a direct user ID mention: <id> or <!id> (already stripped the <@)
          const idMatch = cleaned.match(/^!?(\d{17,19})/);
          if (idMatch) {
            userId = idMatch[1];
          } 
          // Otherwise it's a plain username/nickname
          else {
            // Take everything before any < or extra @ symbols
            const username = cleaned.split('<')[0].split('@')[0].trim().toLowerCase();
            userId = usernameToUserId[username];
            
            if (!userId) {
              console.warn(`Could not resolve username: @${cleaned.split('<')[0].split('@')[0].trim()}`);
            }
          }
          
          if (userId && /^\d{17,19}$/.test(userId)) {
            dayResults.push([userId, score]);
          }
        }
      }
      
      if (dayResults.length > 0) {
        scores[wordleNumber] = dayResults;
      }
    }
  }
  return scores;
}

// Function to calculate leaderboard
export function calculateLeaderboard(scores, options) {
  const {
    xIsSeven = false,
    gameCutoff = 3,
    statsMethod = 'Elo',
    eloMethod = 'Iterated',
    eloK = 2.0,
    dayAdjustment = true,
    bayesAdjustment = true
  } = options;
  
  // Get all players
  const allPlayers = [...new Set(
    Object.values(scores).flat().map(([player, score]) => player)
  )];
  
  // Count games per player
  const numGames = {};
  for (const player of allPlayers) {
    numGames[player] = Object.values(scores)
      .flat()
      .filter(([p, s]) => p === player).length;
  }
  
  if (statsMethod === 'Elo') {
    if (eloMethod === 'MAP') {
      // Create win matrix
      const playerIndex = {};
      allPlayers.forEach((player, idx) => {
        playerIndex[player] = idx;
      });
      
      const winMatrix = Array(allPlayers.length).fill(null)
        .map(() => Array(allPlayers.length).fill(0));
      
      for (const dayGames of Object.values(scores)) {
        for (const [player1, score1] of dayGames) {
          for (const [player2, score2] of dayGames) {
            if (player1 === player2) continue;
            
            const idx1 = playerIndex[player1];
            const idx2 = playerIndex[player2];
            
            winMatrix[idx1][idx2] += points(score1, score2, xIsSeven ? 7 : 6);
          }
        }
      }
      
      const { elos } = calcMapElos(winMatrix);
      
      return allPlayers
        .map((player, idx) => ({
          player,
          numGames: numGames[player],
          rating: elos[idx]
        }))
        .filter(p => p.numGames >= gameCutoff)
        .sort((a, b) => b.rating - a.rating);
        
    } else { // Iterated
      const eloHistory = calcEloIterated(
        Object.values(scores),
        allPlayers,
        eloK,
        xIsSeven ? 7 : 6
      );
      
      const finalElos = eloHistory[eloHistory.length - 1];
      
      return allPlayers
        .map((player, idx) => ({
          player,
          numGames: numGames[player],
          rating: finalElos[idx]
        }))
        .filter(p => p.numGames >= gameCutoff)
        .sort((a, b) => b.rating - a.rating);
    }
  } else { // Average
    // Convert to the format needed for analysis
    const allScoresByDay = {};
    const playerDayScores = {};
    
    // Collect all scores by day and by player
    for (const player of allPlayers) {
      playerDayScores[player] = {};
    }
    
    let dayIndex = 0;
    for (const [date, dayGames] of Object.entries(scores)) {
      allScoresByDay[dayIndex] = [];
      
      for (const [player, score] of dayGames) {
        allScoresByDay[dayIndex].push(score);
        playerDayScores[player][dayIndex] = score;
      }
      dayIndex++;
    }
    
    // Calculate overall average
    const allGameScores = Object.values(allScoresByDay).flat();
    const overallAverage = allGameScores.reduce((sum, score) => sum + score, 0) / allGameScores.length;
    
    // Calculate day effects if day adjustment is enabled
    const dayEffects = {};
    if (dayAdjustment) {
      for (const [day, dayScores] of Object.entries(allScoresByDay)) {
        const dayAvg = dayScores.reduce((sum, score) => sum + score, 0) / dayScores.length;
        dayEffects[day] = dayAvg - overallAverage;
      }
    } else {
      // No day adjustment - all effects are zero
      for (const day of Object.keys(allScoresByDay)) {
        dayEffects[day] = 0.0;
      }
    }
    
    // Calculate player statistics
    const playerStats = [];
    for (const [player, dayScores] of Object.entries(playerDayScores)) {
      const scoreDays = Object.keys(dayScores);
      if (scoreDays.length === 0) continue;
      
      // Calculate day-adjusted scores
      const rawScores = Object.values(dayScores);
      const adjustedScores = [];
      
      for (const [day, rawScore] of Object.entries(dayScores)) {
        const dayEffect = dayEffects[day];
        const adjustedScore = rawScore - dayEffect; // Remove day difficulty
        adjustedScores.push(adjustedScore);
      }
      
      const nGames = adjustedScores.length;
      const rawAvg = rawScores.reduce((sum, score) => sum + score, 0) / rawScores.length;
      const adjustedAvg = adjustedScores.reduce((sum, score) => sum + score, 0) / adjustedScores.length;
      
      let adjustedVar = NaN;
      let adjustedStd = NaN;
      let adjustedSe = NaN;
      
      if (nGames > 1) {
        // Calculate variance with Bessel's correction (ddof=1)
        const meanAdj = adjustedAvg;
        adjustedVar = adjustedScores.reduce((sum, score) => sum + Math.pow(score - meanAdj, 2), 0) / (nGames - 1);
        adjustedStd = Math.sqrt(adjustedVar);
        adjustedSe = adjustedStd / Math.sqrt(nGames);
      }
      
      playerStats.push({
        player,
        numGames: nGames,
        rawAvg,
        adjustedAvg,
        adjustedVar,
        adjustedStd,
        adjustedSe,
        dayAdjustment: rawAvg - adjustedAvg
      });
    }
    
    let finalStats = playerStats;
    
    // Apply Bayesian adjustment if enabled
    if (bayesAdjustment && playerStats.length > 0) {
      // Remove players with too few games for variance calculation
      const reliableStats = playerStats.filter(p => p.numGames >= 2);
      
      if (reliableStats.length > 0) {
        // Empirical Bayes on day-adjusted scores
        const adjustedPopMean = overallAverage;
        
        // Estimate between-player variance using day-adjusted scores
        const sampleMeans = reliableStats.map(p => p.adjustedAvg);
        const weights = reliableStats.map(p => p.numGames);
        const totalWeight = weights.reduce((sum, w) => sum + w, 0);
        
        // Weighted variance of day-adjusted sample means
        const weightedMean = sampleMeans.reduce((sum, mean, i) => sum + mean * weights[i], 0) / totalWeight;
        const weightedVarMeans = sampleMeans.reduce((sum, mean, i) => 
          sum + weights[i] * Math.pow(mean - adjustedPopMean, 2), 0) / totalWeight;
        
        // Average sampling variance from day-adjusted scores
        const avgSamplingVar = reliableStats.reduce((sum, p, i) => 
          sum + weights[i] * (p.adjustedVar / p.numGames), 0) / totalWeight;
        
        // Between-player variance
        const tauSquared = Math.max(0.01, weightedVarMeans - avgSamplingVar);
        
        // Calculate shrinkage using day-adjusted data
        for (const stat of reliableStats) {
          stat.shrinkageFactor = tauSquared / (tauSquared + stat.adjustedVar / stat.numGames);
          stat.finalScore = stat.shrinkageFactor * stat.adjustedAvg + 
                           (1 - stat.shrinkageFactor) * adjustedPopMean;
        }
        
        // Handle single-game players
        const singleGameStats = playerStats.filter(p => p.numGames === 1);
        for (const stat of singleGameStats) {
          stat.finalScore = adjustedPopMean; // Full shrinkage to population mean
        }
        
        finalStats = [...reliableStats, ...singleGameStats];
      } else {
        // If no players have enough games for Bayesian adjustment
        for (const stat of playerStats) {
          stat.finalScore = stat.adjustedAvg;
        }
        finalStats = playerStats;
      }
    } else {
      // No Bayesian adjustment
      for (const stat of playerStats) {
        stat.finalScore = stat.adjustedAvg;
      }
      finalStats = playerStats;
    }
    
    // Filter by minimum games and sort
    return finalStats
      .filter(p => p.numGames >= gameCutoff)
      .sort((a, b) => a.finalScore - b.finalScore) // Lower scores are better
      .map(p => ({
        player: p.player,
        numGames: p.numGames,
        rating: p.finalScore
      }));
  }
}

// SVG Generation
const COLORS = {
  background: '#2b2d31',
  tableBackground: '#313338',
  headerBackground: '#5865f2',
  oddRow: '#2b2d31',
  evenRow: '#313338',
  white: '#fff',
  gray: '#b9bbbe',
  green: '#00d4aa',
  gold: '#ffd700',
  silver: '#c0c0c0',
  bronze: '#cd7f32'
};

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getRankColor(rank) {
  if (rank === 1) return COLORS.gold;
  if (rank === 2) return COLORS.silver;
  if (rank === 3) return COLORS.bronze;
  return COLORS.gray;
}

function getRowColor(index) {
  return index % 2 === 0 ? COLORS.oddRow : COLORS.evenRow;
}

function wrapText(text, maxChars) {
  if (text.length <= maxChars) {
    return [text];
  }
  
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length <= maxChars) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = word;
    }
  }
  
  if (currentLine) {
    lines.push(currentLine);
  }
  
  return lines;
}

export function generateLeaderboardSVG(leaderboard, statsMethod, dataSource = '') {
  const isElo = statsMethod === 'Elo';
  const data = leaderboard.map((entry, idx) => ({
    rank: idx + 1,
    player: entry.player,
    elo: entry.rating.toFixed(2),
    games: entry.numGames
  }));
  
  const width = 460;
  const padding = 10;
  const tableWidth = 440;
  const headerHeight = 32;
  const baseRowHeight = 28;
  const titleHeight = 40;
  const maxPlayerNameChars = 28;
  
  // Pre-calculate row heights based on text wrapping
  const rowHeights = data.map(row => {
    const lines = wrapText(row.player, maxPlayerNameChars);
    return Math.max(baseRowHeight, lines.length * 18 + 10);
  });
  
  const tableHeight = headerHeight + rowHeights.reduce((sum, h) => sum + h, 0);
  const totalHeight = padding * 2 + titleHeight + tableHeight;

  const ratingLabel = isElo ? 'ELO' : 'AVG';
  const title = isElo ? 'Elo Leaderboard' : 'Average Score Leaderboard';

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
  <defs>
    <style>
      .title { font: 600 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; fill: ${COLORS.white}; }
      .header { font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; fill: ${COLORS.white}; text-transform: uppercase; letter-spacing: 0.5px; }
      .rank-text { font: 600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .player-text { font: 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; fill: ${COLORS.white}; }
      .elo-text { font: 500 15px 'Courier New', monospace; fill: ${COLORS.green}; }
      .games-text { font: 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; fill: ${COLORS.gray}; }
    </style>
  </defs>
  
  <!-- Background -->
  <rect width="${width}" height="${totalHeight}" fill="${COLORS.background}"/>
  
  <!-- Title -->
  <text x="${padding}" y="${padding + 24}" class="title">${escapeXml(title)}</text>
  
  <!-- Table background with rounded corners -->
  <rect x="${padding}" y="${padding + titleHeight}" width="${tableWidth}" height="${tableHeight}" rx="8" fill="${COLORS.tableBackground}"/>
  
  <!-- Header background -->
  <rect x="${padding}" y="${padding + titleHeight}" width="${tableWidth}" height="${headerHeight}" rx="8" fill="${COLORS.headerBackground}"/>
  <rect x="${padding}" y="${padding + titleHeight + 8}" width="${tableWidth}" height="${headerHeight - 8}" fill="${COLORS.headerBackground}"/>
  
  <!-- Header text -->
  <text x="${padding + 8}" y="${padding + titleHeight + 21}" class="header"></text>
  <text x="${padding + 40}" y="${padding + titleHeight + 21}" class="header">PLAYER</text>
  <text x="${padding + 280}" y="${padding + titleHeight + 21}" class="header">${ratingLabel}</text>
  <text x="${padding + 380}" y="${padding + titleHeight + 21}" class="header">GAMES</text>
`;

  // Generate rows
  let currentY = padding + titleHeight + headerHeight;
  
  data.forEach((row, index) => {
    const y = currentY;
    const rowHeight = rowHeights[index];
    const rowColor = getRowColor(index);
    const rankColor = getRankColor(row.rank);
    
    // Row background
    svg += `  <rect x="${padding}" y="${y}" width="${tableWidth}" height="${rowHeight}" fill="${rowColor}"/>\n`;
    
    // Calculate vertical center for single-line content
    const singleLineY = y + (rowHeight / 2) + 5;
    
    // Rank (vertically centered)
    svg += `  <text x="${padding + 8}" y="${singleLineY}" class="rank-text" fill="${rankColor}">${row.rank}</text>\n`;
    
    // Player name (with wrapping, vertically centered)
    const nameLines = wrapText(row.player, maxPlayerNameChars);
    if (nameLines.length === 1) {
      svg += `  <text x="${padding + 40}" y="${singleLineY}" class="player-text">${escapeXml(row.player)}</text>\n`;
    } else {
      const textBlockHeight = nameLines.length * 16;
      const startY = y + (rowHeight - textBlockHeight) / 2 + 12;
      svg += `  <text x="${padding + 40}" y="${startY}" class="player-text">\n`;
      nameLines.forEach((line, i) => {
        svg += `    <tspan x="${padding + 40}" dy="${i === 0 ? 0 : 16}">${escapeXml(line)}</tspan>\n`;
      });
      svg += `  </text>\n`;
    }
    
    // Elo (vertically centered)
    svg += `  <text x="${padding + 280}" y="${singleLineY}" class="elo-text">${row.elo}</text>\n`;
    
    // Games (right-aligned, vertically centered)
    svg += `  <text x="${padding + 425}" y="${singleLineY}" class="games-text" text-anchor="end">${row.games}</text>\n`;
    
    currentY += rowHeight;
  });

  svg += '</svg>';
  return svg;
}