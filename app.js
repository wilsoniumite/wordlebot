import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';

import {
  fetchChannelMessages,
  parseWordleResults,
  calculateLeaderboard,
  formatLeaderboard,
  fetchUserInfo,
  filterScores
} from './utils.js';

import {
  saveWordleResults,
  getWordleResults,
  getUserStats,
  hashUserId
} from './db.js';

const UMAMI_URL = process.env.UMAMI_URL;
const UMAMI_WEBSITE_ID = process.env.UMAMI_WEBSITE_ID;


const app = express();
const PORT = process.env.PORT || 3000;

async function trackEvent(event, data = {}) {
  if (!UMAMI_URL || !UMAMI_WEBSITE_ID) return;
  
  try {
    const response = await fetch(`${UMAMI_URL}/api/send`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        payload: {
          hostname: 'discord-bot',
          language: 'en-US',
          referrer: '',
          screen: '1920x1080',
          title: event,
          url: `/interactions/${event}`,
          website: UMAMI_WEBSITE_ID,
          name: event,
          data: data
        },
        type: 'event'
      })
    });
  } catch (err) {
    console.error('Umami tracking error:', err.message);
  }
}

app.use('/interactions', (req, res, next) => {
  let tracked = false;
  
  res.on('finish', () => {
    if (!tracked && req.body?.data?.name) {
      tracked = true;
      trackEvent(req.body.data.name, {
        guild: req.body?.guild_id,
        user: req.body?.member?.user?.id || req.body?.user?.id
      });
    }
  });
  
  next();
});

app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  const { id, type, data } = req.body;
  
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }
  
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = data;
    
    if (name === 'test') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: 'Hello world! The Wordle stats bot is working! 🎯'
        },
      });
    }
    
    if (name === 'sync') {
      try {
        // Parse options
        const optionsMap = {};
        if (options) {
          options.forEach(option => {
            optionsMap[option.name] = option.value;
          });
        }
        
        const channelId = req.body.channel_id;
        const guildId = req.body.guild_id;
        const messageLimit = optionsMap.message_limit || 1000;
        
        // Send initial ephemeral response
        res.send({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: 64 // EPHEMERAL flag
          }
        });
        
        // Fetch and parse messages
        console.log(`[Sync] Fetching up to ${messageLimit} messages from channel ${channelId}`);
        const messages = await fetchChannelMessages(channelId, messageLimit);
        console.log(`[Sync] Fetched ${messages.length} messages`);
        
        const channelScores = await parseWordleResults(messages, guildId);
        console.log(`[Sync] Parsed results for ${Object.keys(channelScores).length} days`);
        
        if (Object.keys(channelScores).length === 0) {
          return await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: '✅ Sync complete! No Wordle results found in this channel.'
            })
          });
        }
        
        // Calculate some stats
        const totalPuzzles = Object.keys(channelScores).length;
        const totalGames = Object.values(channelScores).reduce((sum, day) => sum + day.length, 0);
        const uniqueUsers = new Set(
          Object.values(channelScores).flat().map(([userId, score]) => userId)
        ).size;
        
        // Save to database
        console.log('[Sync] Saving results to database...');
        const saveResult = await saveWordleResults(channelScores);
        
        // Send success message (ephemeral)
        await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `✅ **Sync Complete!**\n\n` +
                     `🧩 Puzzles: ${totalPuzzles}\n` +
                     `🎮 Games: ${totalGames}\n` +
                     `👥 Players: ${uniqueUsers}\n` +
                     `💾 Saved: ${saveResult.new} new, ${saveResult.updated} updated\n\n` +
                     `*Database has been updated with results from this channel.*`
          })
        });
        
      } catch (error) {
        console.error('[Sync] Error syncing data:', error);
        console.error(error.stack);
        await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `❌ Sync failed: ${error.message}`
          })
        });
      }
      return;
    }
    
    if (name === 'personal_stats') {
      try {
        // Get the user ID from the interaction
        const userId = req.body.member?.user?.id || req.body.user?.id;
        
        if (!userId) {
          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '❌ Could not identify user.',
              flags: 64 // EPHEMERAL
            }
          });
        }
        
        // Send initial ephemeral response
        res.send({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: 64 // EPHEMERAL
          }
        });
        
        // Get user stats from database
        console.log(`[PersonalStats] Fetching stats for user ${userId}`);
        const stats = await getUserStats(userId);
        
        if (stats.totalGames === 0) {
          return await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: '📊 **Your Wordle Statistics**\n\n' +
                       'No games found! Start playing Wordle and sync the channel with `/sync` to see your stats.'
            })
          });
        }
        
        // Format the stats message
        const username = await fetchUserInfo(userId);
        let message = `📊 **Wordle Statistics for ${username}**\n\n`;
        
        // Overall stats
        message += `**📈 Overall Performance**\n`;
        message += `├ Total Games: **${stats.totalGames}**\n`;
        message += `├ Average Score: **${stats.avgScore.toFixed(2)}**\n`;
        message += `├ Best Score: **${stats.bestScore}**/6\n`;
        message += `└ Worst Score: **${stats.worstScore}**/6\n\n`;
        
        // Score distribution
        message += `**📊 Score Distribution**\n`;
        const totalGames = stats.totalGames;
        const scoreLabels = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '❌'];
        
        for (let score = 1; score <= 7; score++) {
          const dist = stats.distribution.find(d => d.score === score);
          const count = dist ? dist.count : 0;
          const percentage = ((count / totalGames) * 100).toFixed(1);
          const barLength = Math.round((count / totalGames) * 15);
          const bar = '█'.repeat(barLength) + '░'.repeat(15 - barLength);
          
          message += `${scoreLabels[score - 1]} ${bar} ${count} (${percentage}%)\n`;
        }
        
        // Recent games
        if (stats.recent.length > 0) {
          message += `\n**🕐 Recent Games** (last ${Math.min(10, stats.recent.length)})\n`;
          const recentScores = stats.recent.map(r => {
            const scoreEmoji = r.score <= 6 ? scoreLabels[r.score - 1] : scoreLabels[6];
            return scoreEmoji;
          }).join(' ');
          message += recentScores + '\n';
        }
        
        // Wordle range
        message += `\n**🧩 Wordle Range**\n`;
        message += `├ First: Wordle #${stats.firstWordle}\n`;
        message += `└ Latest: Wordle #${stats.lastWordle}\n`;
        
        // Send the stats (ephemeral)
        await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: message
          })
        });
        
      } catch (error) {
        console.error('[PersonalStats] Error fetching personal stats:', error);
        console.error(error.stack);
        await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `❌ Error fetching your statistics: ${error.message}`
          })
        });
      }
      return;
    }
    
    if (name === 'leaderboard') {
      try {
        // Parse options
        const optionsMap = {};
        if (options) {
          options.forEach(option => {
            optionsMap[option.name] = option.value;
          });
        }
        
        const channelId = req.body.channel_id;
        const guildId = req.body.guild_id;
        const channelOnly = optionsMap.channel_only || false;
        
        // Send initial response
        res.send({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        });
        
        // Fetch messages from this channel
        console.log('Fetching messages for channel', channelId);
        const messages = await fetchChannelMessages(channelId, 1000);
        console.log(`Fetched ${messages.length} messages`);
        
        const channelScores = await parseWordleResults(messages, guildId);
        console.log(`Parsed results for ${Object.keys(channelScores).length} days from channel`);
        
        if (Object.keys(channelScores).length === 0) {
          return await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: 'No Wordle results found in this channel! 😅'
            })
          });
        }
        
        // Save channel results to database
        console.log('Saving results to database...');
        const saveResult = await saveWordleResults(channelScores);
        console.log(`Saved ${saveResult.total} results to database (${saveResult.new} new, ${saveResult.updated} updated)`);
        
        // Determine which data to use for leaderboard
        let scores;
        if (channelOnly) {
          console.log('Using channel-only data for leaderboard');
          scores = channelScores;
        } else {
          console.log('Fetching all data from database for leaderboard');
          // Get all user IDs from channel to maintain the userId (not hash) in results
          const channelUserIds = [...new Set(
            Object.values(channelScores).flat().map(([userId, score]) => userId)
          )];
          
          // Fetch all data from database for these users
          scores = await getWordleResults(channelUserIds);
          
          console.log(`Using database data: ${Object.keys(scores).length} days`);
        }
        
        // Filter out score 7 (X/failed) if xIsSeven is false
        const xIsSeven = optionsMap.x_is_seven || false;
        scores = filterScores(scores, xIsSeven);
        console.log(`After filtering (xIsSeven=${xIsSeven}): ${Object.keys(scores).length} days`);
        
        // Get all unique user IDs and fetch their usernames
        const allUserIds = [...new Set(
          Object.values(scores).flat().map(([userId, score]) => userId)
        )];
        
        console.log(`Fetching usernames for ${allUserIds.length} users`);
        const userIdToUsername = {};
        
        // Fetch usernames sequentially with small delays
        // The retry logic in fetchUserInfo will handle any rate limits
        for (const userId of allUserIds) {
          const username = await fetchUserInfo(userId);
          userIdToUsername[userId] = username;
          
          // Small delay between requests to be respectful
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const leaderboardOptions = {
          xIsSeven: xIsSeven,
          gameCutoff: optionsMap.game_cutoff || 3,
          statsMethod: optionsMap.stats_method || 'Elo',
          eloMethod: optionsMap.elo_method || 'Iterated',
          eloK: optionsMap.elo_k || 2.0,
          dayAdjustment: optionsMap.day_adjustment !== false,
          bayesAdjustment: optionsMap.bayes_adjustment !== false
        };
        
        console.log('Calculating leaderboard...');
        const leaderboard = calculateLeaderboard(scores, leaderboardOptions);
        
        // Convert user IDs to usernames in the leaderboard
        const leaderboardWithUsernames = leaderboard.map(entry => ({
          ...entry,
          player: userIdToUsername[entry.player] || entry.player
        }));
        
        const dataSource = channelOnly ? ' (Channel Only)' : ' (All Channels)';
        const formattedLeaderboard = formatLeaderboard(
          leaderboardWithUsernames, 
          optionsMap.stats_method || 'Elo', 
          leaderboardOptions,
          dataSource
        );
        
        // Update the deferred response
        await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: formattedLeaderboard
          })
        });
        
      } catch (error) {
        console.error('Error generating leaderboard:', error);
        console.error(error.stack);
        await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `Sorry, there was an error generating the leaderboard! 😞\n\`\`\`${error.message}\`\`\``
          })
        });
      }
      return;
    }
    
    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }
  
  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});