import 'dotenv/config';
import fetch from 'node-fetch';

async function InstallGlobalCommands(appId, commands) {
  // API endpoint to overwrite global commands
  const endpoint = `applications/${appId}/commands`;
  try {
    // This is calling the bulk overwrite endpoint
    await DiscordRequest(endpoint, { method: 'PUT', body: commands });
    console.log('Successfully registered commands');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
}

async function DiscordRequest(endpoint, options) {
  // append endpoint to root API URL
  const url = 'https://discord.com/api/v10/' + endpoint;
  // Stringify payloads
  if (options.body) options.body = JSON.stringify(options.body);
  // Use fetch to make requests
  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': 'DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)',
    },
    ...options
  });
  // throw API errors
  if (!res.ok) {
    const data = await res.json();
    console.log(res.status);
    throw new Error(JSON.stringify(data));
  }
  // return original response
  return res;
}

// Simple test command
const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command to test if the bot is working',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const PERSONAL_STATS_COMMAND = {
  name: 'personal_stats',
  description: 'View your personal Wordle statistics',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Sync command to update database without showing leaderboard
const SYNC_COMMAND = {
  name: 'sync',
  description: 'Read channel messages and update database (no leaderboard shown)',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      name: 'message_limit',
      description: 'Maximum number of messages to scan (default: 1000)',
      type: 4, // INTEGER
      required: false,
      min_value: 100,
      max_value: 5000
    }
  ]
};

// Wordle leaderboard command
const LEADERBOARD_COMMAND = {
  name: 'leaderboard',
  description: 'Generate Wordle statistics leaderboard from channel messages',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      name: 'channel_only',
      description: 'Only use data from this channel (default: false, uses all channels)',
      type: 5, // BOOLEAN
      required: false
    },
    {
      name: 'stats_method',
      description: 'Statistical method to use for rankings',
      type: 3, // STRING
      required: false,
      choices: [
        {
          name: 'Elo Rating',
          value: 'Elo'
        },
        {
          name: 'Average Score',
          value: 'Average'
        }
      ]
    },
    {
      name: 'game_cutoff',
      description: 'Minimum number of games played to be included (default: 3)',
      type: 4, // INTEGER
      required: false,
      min_value: 1,
      max_value: 100
    },
    {
      name: 'x_is_seven',
      description: 'Count X (failed attempts) as score 7 instead of excluding (default: false)',
      type: 5, // BOOLEAN
      required: false
    },
    {
      name: 'elo_method',
      description: 'Elo calculation method (only used when stats_method is Elo)',
      type: 3, // STRING
      required: false,
      choices: [
        {
          name: 'Iterated',
          value: 'Iterated'
        },
        {
          name: 'MAP (Maximum A Posteriori)',
          value: 'MAP'
        }
      ]
    },
    {
      name: 'elo_k',
      description: 'Elo K-factor for Iterated method (default: 2.0)',
      type: 10, // NUMBER
      required: false,
      min_value: 0.1,
      max_value: 30.0
    },
    {
      name: 'day_adjustment',
      description: 'Adjust scores by day difficulty for Average method (default: true)',
      type: 5, // BOOLEAN
      required: false
    },
    {
      name: 'bayes_adjustment',
      description: 'Use Bayesian adjustment for Average method (default: true)',
      type: 5, // BOOLEAN
      required: false
    }
  ]
};

const ALL_COMMANDS = [TEST_COMMAND, PERSONAL_STATS_COMMAND, SYNC_COMMAND, LEADERBOARD_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);