import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'fs/promises';
import readline from 'readline';

const { Pool } = pg;

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Get the most recently used channel per guild
async function getMostRecentChannelPerGuild() {
  const client = await pool.connect();
  
  try {
    // Get the most recent channel_id for each unique guild
    // We need to get guild_id from Discord API since we only store channel_id
    const result = await client.query(`
      SELECT DISTINCT ON (channel_id) 
        channel_id,
        MAX(completed_at) as last_used
      FROM wordle_results
      WHERE channel_id IS NOT NULL AND channel_id != '0'
      GROUP BY channel_id
      ORDER BY channel_id, last_used DESC
    `);
    
    console.log(`📊 Found ${result.rows.length} channels with Wordle activity\n`);
    
    // Fetch guild info for each channel to deduplicate by guild
    const channelsByGuild = new Map();
    
    for (const row of result.rows) {
      try {
        const response = await fetch(
          `https://discord.com/api/v10/channels/${row.channel_id}`,
          {
            headers: {
              Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );
        
        if (!response.ok) {
          console.warn(`⚠️  Could not fetch channel ${row.channel_id}: ${response.status}`);
          continue;
        }
        
        const channel = await response.json();
        const guildId = channel.guild_id;
        
        // Keep the most recently used channel per guild
        if (!channelsByGuild.has(guildId) || 
            new Date(row.last_used) > new Date(channelsByGuild.get(guildId).last_used)) {
          channelsByGuild.set(guildId, {
            guildId,
            channelId: row.channel_id,
            channelName: channel.name,
            guildName: channel.guild_id, // We'll fetch this next
            lastUsed: row.last_used
          });
        }
        
        // Rate limit protection
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`❌ Error fetching channel ${row.channel_id}:`, error.message);
      }
    }
    
    // Fetch guild names
    const channels = Array.from(channelsByGuild.values());
    for (const channel of channels) {
      try {
        const response = await fetch(
          `https://discord.com/api/v10/guilds/${channel.guildId}`,
          {
            headers: {
              Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );
        
        if (response.ok) {
          const guild = await response.json();
          channel.guildName = guild.name;
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`❌ Error fetching guild ${channel.guildId}:`, error.message);
      }
    }
    
    return channels;
  } finally {
    client.release();
  }
}

// Send announcement to a channel
async function sendAnnouncement(channelId, message) {
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: message
        })
      }
    );
    
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    
    return true;
  } catch (error) {
    throw error;
  }
}

// Prompt for confirmation
function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// SAFETY: Test mode by default - only send to test guild
// To send to ALL guilds, run with: node scripts/send-announcement.js --production
const TEST_GUILD_ID = '714117188830887936';
const isProductionMode = process.argv.includes('--production') || process.argv.includes('--all');

// Main function
async function main() {
  try {
    console.log('🤖 Discord Wordle Bot - Announcement Sender\n');
    console.log('===========================================\n');
    
    if (!isProductionMode) {
      console.log('🔒 TEST MODE: Only sending to guild ' + TEST_GUILD_ID);
      console.log('   To send to ALL guilds, run with --production flag\n');
    } else {
      console.log('🌍 PRODUCTION MODE: Sending to ALL guilds');
      console.log('   ⚠️  This will send to every server where the bot has been used!\n');
    }
    
    // Read announcement file
    console.log('📄 Reading announcement.md...');
    let announcementText;
    try {
      announcementText = await readFile('scripts/announcement.md', 'utf-8');
      announcementText = announcementText.trim();
      
      if (!announcementText) {
        console.error('❌ announcement.md is empty!');
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Could not read announcement.md');
      console.error('   Make sure to create this file in the scripts/ directory.');
      process.exit(1);
    }
    
    console.log('\n📝 Announcement message:');
    console.log('─'.repeat(50));
    console.log(announcementText);
    console.log('─'.repeat(50));
    console.log(`\n📏 Length: ${announcementText.length}/2000 characters\n`);
    
    if (announcementText.length > 2000) {
      console.error('❌ Message is too long! Discord messages must be 2000 characters or less.');
      process.exit(1);
    }
    
    // Get channels
    console.log('🔍 Finding most recently used channel per guild...\n');
    const allChannels = await getMostRecentChannelPerGuild();
    
    // Filter to test guild if in test mode
    let channels;
    if (!isProductionMode) {
      channels = allChannels.filter(channel => channel.guildId === TEST_GUILD_ID);
      
      if (allChannels.length > 0 && channels.length === 0) {
        console.log(`❌ Test guild ${TEST_GUILD_ID} not found in database!`);
        console.log(`   Found ${allChannels.length} other guild(s).\n`);
        console.log('   Make sure you\'ve used the bot in your test server and run /sync');
        process.exit(1);
      }
    } else {
      channels = allChannels;
    }
    
    if (channels.length === 0) {
      console.log('❌ No channels found! Has the bot been used anywhere?');
      process.exit(1);
    }
    
    console.log(`✅ Found ${channels.length} guild(s) where the bot has been used:\n`);
    
    // Display preview
    channels.forEach((channel, index) => {
      const lastUsedDate = new Date(channel.lastUsed).toLocaleDateString();
      console.log(`${index + 1}. 🏠 ${channel.guildName}`);
      console.log(`   📢 #${channel.channelName}`);
      console.log(`   🕐 Last used: ${lastUsedDate}`);
      console.log();
    });
    
    // Confirm
    const confirmed = await askConfirmation(
      `\n⚠️  Send announcement to ${channels.length} channel(s)? (y/N): `
    );
    
    if (!confirmed) {
      console.log('\n❌ Cancelled. No messages sent.');
      process.exit(0);
    }
    
    // Send announcements
    console.log('\n📤 Sending announcements...\n');
    
    let successCount = 0;
    let failCount = 0;
    
    for (const channel of channels) {
      try {
        await sendAnnouncement(channel.channelId, announcementText);
        console.log(`✅ Sent to ${channel.guildName} (#${channel.channelName})`);
        successCount++;
        
        // Rate limit protection
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`❌ Failed to send to ${channel.guildName}: ${error.message}`);
        failCount++;
      }
    }
    
    // Summary
    console.log('\n===========================================');
    console.log(`\n📊 Summary:`);
    console.log(`   ✅ Sent: ${successCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
    console.log(`   📢 Total: ${channels.length}`);
    console.log('\n✨ Done!\n');
    
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();