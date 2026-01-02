import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { FormData, File } from 'formdata-node';
import sharp from 'sharp';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';

import {
  fetchAndParseMessages,
  calculateLeaderboard,
  generateLeaderboardSVG,
  fetchUserInfo,
  filterScores,
  deduplicateScores
} from './utils.js';

import {
  saveWordleResults,
  getWordleResults,
  getUserStats
} from './db.js';

import { logger, httpLogger } from './logger.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Add HTTP logging middleware
app.use('/interactions', httpLogger);


// Shared leaderboard generation function - OPTIMIZED VERSION
async function generateLeaderboard(req, res, statsMethod) {
  // Create child logger for this request
  const log = req.log.child({ function: 'generateLeaderboard', statsMethod });
  
  try {
    const { options } = req.body.data;

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

    log.info({ channelId, guildId, channelOnly, options: optionsMap }, 'Starting leaderboard generation');

    // Send initial ephemeral response
    res.send({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: 64 // EPHEMERAL
      }
    });

    // OPTIMIZATION: First, get existing data from DB for this channel
    log.debug({ channelId }, 'Fetching existing data from DB');
    const existingScores = await getWordleResults(null, null, null, channelId, log);
    log.info({ daysCount: Object.keys(existingScores).length }, 'Found days in DB for this channel');

    // Check for hashed user IDs and collect message IDs in a single pass
    let hasHashedUsers = false;
    const existingMessageIds = new Set();

    for (const dayResults of Object.values(existingScores)) {
      for (const entry of dayResults) {
        // Check if this is a hashed entry (64 char hex string with letters)
        if (entry.userId && entry.userId.length === 64 && /[a-f]/.test(entry.userId)) {
          hasHashedUsers = true;
          // Clear message IDs and break early since we can't use early termination with hashed users
          existingMessageIds.clear();
          break;
        }

        // Collect message IDs for early termination (if no hashed users found)
        if (entry.messageId) {
          existingMessageIds.add(entry.messageId);
        }
      }
      if (hasHashedUsers) break;
    }

    log.debug({ 
      hasHashedUsers, 
      existingMessageIdsCount: existingMessageIds.size 
    }, 'Checked for hashed users and existing message IDs');

    // OPTIMIZATION: Use optimized fetch with early termination and parallel processing
    log.info('Fetching messages with parallel processing');
    const newScores = await fetchAndParseMessages(channelId, guildId, existingMessageIds, 1000, log);
    log.info({ newDaysCount: Object.keys(newScores).length }, 'Found new days from Discord');

    // Merge new scores with existing scores
    const channelScores = { ...existingScores };
    for (const [wordleNumber, dayResults] of Object.entries(newScores)) {
      if (channelScores[wordleNumber]) {
        // Merge with existing data for this day (shouldn't happen often, but handle it)
        channelScores[wordleNumber] = [...channelScores[wordleNumber], ...dayResults];
      } else {
        channelScores[wordleNumber] = dayResults;
      }
    }
    log.info({ totalDays: Object.keys(channelScores).length }, 'Total data after merge');

    if (Object.keys(channelScores).length === 0) {
      log.warn('No Wordle results found in channel');
      return await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'No Wordle results found in this channel! 😅'
        })
      });
    }

    // Save NEW results to database (only if we found new data)
    if (Object.keys(newScores).length > 0) {
      log.info('Saving new results to database');
      const saveResult = await saveWordleResults(newScores, channelId, log);
      log.info(saveResult, 'Saved results to database');
    } else {
      log.debug('No new results to save - all data was in DB already');
    }

    // Determine which data to use for leaderboard
    let scores;
    if (channelOnly) {
      log.debug('Using channel-only data for leaderboard');
      scores = channelScores;
    } else {
      log.debug('Fetching all data from database for leaderboard');
      // Get all user IDs from channel to maintain the userId (not hash) in results
      const channelUserIds = [...new Set(
        Object.values(channelScores).flat().map(entry => entry.userId)
      )];

      // Fetch all data from database for these users (all channels)
      scores = await getWordleResults(channelUserIds, null, null, null, log);

      log.info({ daysCount: Object.keys(scores).length }, 'Using database data');
    }

    // Filter out score 7 (X/failed) if xIsSeven is false
    const xIsSeven = optionsMap.x_is_seven || false;
    scores = filterScores(scores, xIsSeven);
    log.debug({ xIsSeven, daysCount: Object.keys(scores).length }, 'After filtering');

    // IMPORTANT: Filter out hashed user IDs before processing
    let hashedEntriesRemoved = 0;
    const scoresWithoutHashes = {};

    for (const [wordleNumber, dayResults] of Object.entries(scores)) {
      const filteredResults = dayResults.filter(entry => {
        const isHashed = entry.userId && entry.userId.length === 64 && /[a-f]/.test(entry.userId);
        if (isHashed) {
          hashedEntriesRemoved++;
          return false;
        }
        return true;
      });

      if (filteredResults.length > 0) {
        scoresWithoutHashes[wordleNumber] = filteredResults;
      }
    }

    scores = scoresWithoutHashes;

    if (hashedEntriesRemoved > 0) {
      log.info({ hashedEntriesRemoved }, 'Filtered out hashed entries');
    }

    log.debug({ daysCount: Object.keys(scores).length }, 'Using days for leaderboard calculation');

    // Deduplicate scores (same user + wordle number in different channels)
    scores = deduplicateScores(scores, channelId);
    log.debug({ daysCount: Object.keys(scores).length }, 'After deduplication');

    // Get all unique user IDs and fetch their usernames
    const allUserIds = [...new Set(
      Object.values(scores).flat().map(entry => entry.userId)
    )];

    log.info({ userCount: allUserIds.length }, 'Fetching usernames');
    const userIdToUsername = {};

    // Fetch usernames sequentially with small delays
    for (const userId of allUserIds) {
      const username = await fetchUserInfo(userId, log);
      userIdToUsername[userId] = username;

      // Small delay between requests to be respectful
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const leaderboardOptions = {
      xIsSeven: xIsSeven,
      gameCutoff: optionsMap.game_cutoff || 3,
      statsMethod: statsMethod,
      eloMethod: optionsMap.elo_method || 'Iterated',
      eloK: optionsMap.elo_k || 2.0,
      dayAdjustment: optionsMap.day_adjustment !== false,
      bayesAdjustment: optionsMap.bayes_adjustment !== false
    };

    log.info({ options: leaderboardOptions }, 'Calculating leaderboard');
    const leaderboard = calculateLeaderboard(scores, leaderboardOptions);

    // Convert user IDs to usernames in the leaderboard
    const leaderboardWithUsernames = leaderboard.map(entry => ({
      ...entry,
      player: userIdToUsername[entry.player] || entry.player
    }));

    // Generate SVG
    log.debug('Generating SVG leaderboard');
    const dataSource = channelOnly ? ' (Channel Only)' : ' (All Channels)';
    const svgContent = generateLeaderboardSVG(
      leaderboardWithUsernames,
      statsMethod,
      dataSource
    );

    // Convert SVG to PNG using sharp
    log.debug('Converting SVG to PNG');
    const pngBuffer = await sharp(Buffer.from(svgContent))
      .png()
      .toBuffer();

    // Create FormData and attach the PNG
    const formData = new FormData();

    // Create a File object from the PNG buffer
    const pngFile = new File([pngBuffer], 'leaderboard.png', { type: 'image/png' });
    formData.append('files[0]', pngFile);

    // Add the message payload with a "Publish" button
    formData.append('payload_json', JSON.stringify({
      content: `📊 **Leaderboard Preview**${dataSource}\n*This is only visible to you. Click "Publish" to share it with everyone.*`,
      components: [
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.BUTTON,
              style: ButtonStyleTypes.PRIMARY,
              label: '📢 Publish Leaderboard',
              custom_id: 'publish_leaderboard'
            }
          ]
        }
      ]
    }));

    // Send ephemeral message with button
    await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
      method: 'PATCH',
      body: formData
    });

    log.info('Leaderboard generation completed successfully');

  } catch (error) {
    log.error({ err: error, stack: error.stack }, 'Error generating leaderboard');
    await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `Sorry, there was an error generating the leaderboard! 😞\n\`\`\`${error.message}\`\`\``
      })
    });
  }
}

app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  const { id, type, data } = req.body;

  req.log = req.log.child({
    interactionId: id,
    guildId: req.body?.guild_id,
    channelId: req.body?.channel_id,
    userId: req.body?.member?.user?.id || req.body?.user?.id,
    command: req.body?.data?.name,
    interactionType: type,
  });

  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id } = data;

    if (custom_id === 'publish_leaderboard') {
      const log = req.log.child({ function: 'publishLeaderboard' });
      
      try {
        // Get the attachment from the ephemeral message
        const message = req.body.message;
        const attachment = message?.attachments?.[0];

        log.debug({ 
          hasMessage: !!message, 
          attachmentCount: message?.attachments?.length || 0 
        }, 'Checking for attachment');

        if (!attachment) {
          log.error({ message }, 'No attachment found');
          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '❌ Could not find leaderboard image to publish.',
              flags: 64 // EPHEMERAL
            }
          });
        }

        log.debug({ filename: attachment.filename || attachment.id }, 'Found attachment');

        // Send deferred response
        res.send({
          type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE
        });

        // Fetch the image from the attachment URL
        log.debug({ url: attachment.url }, 'Fetching image');
        const imageResponse = await fetch(attachment.url);
        const imageBuffer = await imageResponse.arrayBuffer();

        // Create FormData with the image
        const formData = new FormData();
        const imageFile = new File([imageBuffer], 'leaderboard.png', { type: 'image/png' });
        formData.append('files[0]', imageFile);

        // Post as a new message in the channel (public)
        formData.append('payload_json', JSON.stringify({
          content: '📊 Wordle Leaderboard'
        }));

        // Post to channel
        log.info({ channelId: req.body.channel_id }, 'Posting leaderboard to channel');
        await fetch(`https://discord.com/api/v10/channels/${req.body.channel_id}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${process.env.DISCORD_TOKEN}`
          },
          body: formData
        });

        log.info('Successfully posted to channel');

        // Update the ephemeral message to show it was published
        await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: '✅ Leaderboard published!',
            components: [] // Remove the button
          })
        });

      } catch (error) {
        log.error({ err: error, stack: error.stack }, 'Error publishing leaderboard');
        await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `❌ Error publishing leaderboard: ${error.message}`,
            components: []
          })
        });
      }
      return;
    }
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

    if (name === 'help') {
      const helpMessage = `**📊 Wordle Stats Bot**
        **Commands**
        Most of these are only available in servers! This is because the bot needs to be able to read message history.

        \`/help\` - Show this message
        \`/sync\` - Update database with channel messages, up to 50,000 messages
        \`/personal_stats\` - View your statistics
        \`/elo_leaderboard\` - Generate Elo-based rankings
        \`/average_leaderboard\` - Generate average-score-based rankings

        **Options** (for leaderboards)
        • \`channel_only\` - Only use this channel (default: false)
        • \`game_cutoff\` - Min games to qualify (default: 3)
        • \`x_is_seven\` - Count X/fails as score 7 (default: false)

        **Elo Leaderboard Options**
        • \`elo_method\` - Iterated or MAP (default: Iterated)
        • \`elo_k\` - K-factor sensitivity (default: 2.0)

        **Average Leaderboard Options**
        • \`day_adjustment\` - Adjust averages for puzzle difficulty (default: true)
        • \`bayes_adjustment\` - Shrink averages toward global mean for users with few games (default: true)

        For more information and details about the options, you can read my blog post at https://wilsoniumite.com/2025/11/05/calculating-a-wordle-leaderboard/

        **Tips**
        ✓ Run \`/sync\` if the leaderboard doesn't have enough data (leaderboards will only scan up to 1000 messages)

        **Need help or found a bug?** wilson@wilsoniumite.com`;

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: helpMessage,
          flags: 64 // EPHEMERAL - only user sees it
        }
      });
    }

    if (name === 'sync') {
      const log = req.log.child({ function: 'sync' });
      
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

        log.info({ channelId, guildId, messageLimit }, 'Starting sync');

        // Send initial ephemeral response
        res.send({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: 64 // EPHEMERAL flag
          }
        });

        // Fetch and parse messages with parallel processing
        // Pass empty Set for existingMessageIds to disable early termination
        log.info({ messageLimit }, 'Fetching messages');
        const channelScores = await fetchAndParseMessages(channelId, guildId, new Set(), messageLimit, log);
        log.info({ daysCount: Object.keys(channelScores).length }, 'Parsed results');

        if (Object.keys(channelScores).length === 0) {
          log.info('No Wordle results found in channel');
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
          Object.values(channelScores).flat().map(entry => entry.userId)
        ).size;

        log.info({ totalPuzzles, totalGames, uniqueUsers }, 'Sync statistics');

        // Save to database with channel ID and message IDs
        log.info('Saving results to database');
        const saveResult = await saveWordleResults(channelScores, channelId, log);

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

        log.info('Sync completed successfully');

      } catch (error) {
        log.error({ err: error, stack: error.stack }, 'Error syncing data');
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
      const log = req.log.child({ function: 'personalStats' });
      
      try {
        // Get the user ID from the interaction
        const userId = req.body.member?.user?.id || req.body.user?.id;
        const channelId = req.body.channel_id;

        if (!userId) {
          log.warn('Could not identify user');
          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '❌ Could not identify user.',
              flags: 64 // EPHEMERAL
            }
          });
        }

        log.info({ userId, channelId }, 'Fetching personal stats');

        // Send initial ephemeral response
        res.send({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: 64 // EPHEMERAL
          }
        });

        // Get user stats from database
        const stats = await getUserStats(userId, channelId, log);

        if (stats.totalGames === 0) {
          log.info('No games found for user');
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
        const username = await fetchUserInfo(userId, log);
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

        log.info({ totalGames: stats.totalGames, avgScore: stats.avgScore }, 'Personal stats retrieved');

        // Send the stats (ephemeral)
        await fetch(`https://discord.com/api/v10/webhooks/${req.body.application_id}/${req.body.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: message
          })
        });

      } catch (error) {
        log.error({ err: error, stack: error.stack }, 'Error fetching personal stats');
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

    if (name === 'elo_leaderboard') {
      await generateLeaderboard(req, res, 'Elo');
      return;
    }

    if (name === 'average_leaderboard') {
      await generateLeaderboard(req, res, 'Average');
      return;
    }

    logger.error({ command: name }, 'Unknown command');
    return res.status(400).json({ error: 'unknown command' });
  }

  logger.error({ interactionType: type }, 'Unknown interaction type');
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Server started');
});