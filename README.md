# 🎯 Wordle Leaderboard Bot

A sophisticated Discord bot that tracks Wordle results, calculates fair leaderboards using advanced statistical methods, and provides detailed player statistics.

## 🌟 Features

### 📊 Smart Leaderboard Calculations

The bot offers multiple ranking methods to ensure fair competition:

- **Elo Rating System** - Chess-style ratings that account for opponent strength
  - **MAP (Maximum A Posteriori)** - Optimal ratings based on all games simultaneously
  - **Iterated** - Sequential rating updates as games are played
- **Average Score** - Traditional average with sophisticated adjustments
  - Day difficulty normalization
  - Bayesian shrinkage for statistical reliability

### 🎮 Discord Commands

- `/leaderboard` - Generate a leaderboard with customizable options
- `/sync` - Parse and store Wordle results from channel messages
- `/personal_stats` - View your individual Wordle statistics
- `/test` - Verify the bot is running

### 📈 Advanced Features

- **OCR Image Processing** - Automatically extracts Wordle numbers from result images
- **Rate Limit Handling** - Intelligent retry logic for Discord API calls
- **Cross-Channel Tracking** - Aggregate results across multiple channels
- **Privacy-First** - User IDs are hashed in the database
- **Analytics Integration** - Optional Umami analytics support

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose
- A Discord Bot Token ([Discord Developer Portal](https://discord.com/developers/applications))
- PostgreSQL database (included in docker-compose)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/wilsoniumite/wordlebot.git
cd wordlebot
```

2. Create a `.env` file with your configuration:
```env
# Discord Bot Configuration
APP_ID=your_app_id_here
DISCORD_TOKEN=your_bot_token_here
PUBLIC_KEY=your_public_key_here

# Database Configuration
POSTGRES_USER=myuser
POSTGRES_PASSWORD=changeme
POSTGRES_DB=mydb

# Optional: Umami Analytics
UMAMI_URL=your_umami_url
UMAMI_WEBSITE_ID=your_website_id
UMAMI_SECRET=random_secret_string
```

3. Register slash commands:
```bash
npm install
npm run register
```

4. Start the bot with Docker:
```bash
docker-compose up -d
```

The bot will be available at `http://localhost:3000`.

## 📖 Usage Guide

### Setting Up Your Discord Server

1. Invite the bot to your server using the OAuth2 URL from the Discord Developer Portal
2. Grant the bot permissions to read message history and send messages
3. Ensure the bot can access channels where Wordle results are posted

### Syncing Wordle Results

Use the `/sync` command to parse historical messages and extract Wordle results:

```
/sync message_limit:1000
```

The bot will:
- Fetch up to the specified number of messages
- Extract Wordle numbers from images using OCR
- Parse scores and player mentions
- Store results in the database

### Generating Leaderboards

Use the `/leaderboard` command with various options:

```
/leaderboard 
  channel_only:false 
  x_is_seven:false
  game_cutoff:3
  stats_method:Elo
  elo_method:Iterated
  elo_k:2.0
  day_adjustment:true
  bayes_adjustment:true
```

**Options explained:**

- `channel_only` - Use only this channel's data (default: false, uses all channels)
- `x_is_seven` - Count failed attempts (X) as score 7 (default: false, exclude failures)
- `game_cutoff` - Minimum games required to appear on leaderboard (default: 3)
- `stats_method` - Ranking method: `Elo` or `Average` (default: Elo)
- `elo_method` - Elo calculation: `Iterated` or `MAP` (default: Iterated)
- `elo_k` - Elo K-factor, higher = more volatile ratings (default: 2.0)
- `day_adjustment` - Normalize for puzzle difficulty (default: true)
- `bayes_adjustment` - Apply Bayesian shrinkage (default: true)

### Viewing Personal Statistics

Check your own Wordle performance:

```
/personal_stats
```

This displays:
- Total games played
- Average, best, and worst scores
- Score distribution with visual bars
- Recent game history
- Wordle number range

## 🧮 How the Leaderboard Works

### The Fair Ranking Challenge

Not all Wordle puzzles are equally difficult. A player who averages 3.5 on easy puzzles might actually be worse than someone averaging 4.0 on hard ones. This bot solves that problem.

### Elo Rating System

Inspired by chess rankings, the Elo system treats each Wordle result as a series of pairwise "matches" between players who played the same puzzle.

**How it works:**
1. Each player starts at 1000 Elo
2. For each puzzle, players who scored better "beat" those who scored worse
3. Ratings update based on expected vs. actual outcomes
4. Over time, ratings converge to reflect true skill

**Two calculation methods:**

- **Iterated Elo**: Processes games sequentially, simulating how ratings evolve over time
- **MAP Elo**: Computes optimal ratings using all games simultaneously via maximum a posteriori estimation (following Newman 2023)

### Average Score Method

For a more traditional approach, the bot can rank by average score with two key adjustments:

**Day Difficulty Adjustment:**
- Identifies which puzzles were harder/easier based on group performance
- Adjusts individual scores to remove day-to-day variation
- Example: Scoring 4 on a hard day (avg 4.5) becomes adjusted 3.5 on a neutral day

**Bayesian Shrinkage:**
- Accounts for statistical noise in small sample sizes
- Players with few games are "shrunk" toward the population average
- More games = more weight given to individual performance
- Prevents lucky/unlucky streaks from dominating rankings

### The Math Behind It

The bot implements the statistical methods described in detail in [this blog post](https://wilsoniumite.com/2025/11/05/calculating-a-wordle-leaderboard/), including:

- Pairwise Elo updates with customizable K-factor
- Newman's MAP estimation for optimal Elo ratings
- Empirical Bayes shrinkage for average scores
- Day effect calculation via deviation from grand mean

## 🏗️ Technical Architecture

### Stack

- **Runtime**: Node.js with ES modules
- **Framework**: Express.js for HTTP handling
- **Discord**: discord.js and discord-interactions
- **Database**: PostgreSQL with connection pooling
- **OCR**: Tesseract.js for image text extraction
- **Image Processing**: Sharp for image manipulation
- **Deployment**: Docker with docker-compose

### Database Schema

```sql
CREATE TABLE wordle_results (
    user_id_hash VARCHAR(64) NOT NULL,
    wordle_number INTEGER NOT NULL,
    completed_at TIMESTAMP NOT NULL,
    score INTEGER NOT NULL CHECK (score >= 1 AND score <= 7),
    PRIMARY KEY (user_id_hash, wordle_number)
);
```

User IDs are hashed with SHA-256 for privacy before storage.

### Project Structure

```
wordlebot/
├── app.js              # Main application and command handlers
├── utils.js            # Leaderboard calculation and message parsing
├── db.js               # Database operations
├── registerCommands.js # Discord slash command registration
├── Dockerfile          # Container configuration
├── docker-compose.yml  # Multi-service orchestration
├── init.sql            # Database schema
└── package.json        # Dependencies and scripts
```

### Key Algorithms

**Elo Calculation (Iterated):**
```javascript
function calculateElo(elo0, elo1, sa, k) {
  const eloDiff = elo1 - elo0;
  const ea = 1 / (1 + Math.pow(10, eloDiff / 400));
  const eb = 1 - ea;
  const sb = 1 - sa;
  return [elo0 + k * (sa - ea), elo1 + k * (sb - eb)];
}
```

**Point System:**
```javascript
function points(a, b, maxScore = 6) {
  return 0.5 + (b - a) / (maxScore - 1) / 2;
}
```

A player with score `a` gets 0.5 points against an opponent with the same score, 1 point if the opponent scored worse, and 0 points if the opponent scored better. Fractional points based on score difference.

## 🔧 Configuration

### Environment Variables

All configuration is done via environment variables in `.env`:

| Variable | Description | Required |
|----------|-------------|----------|
| `APP_ID` | Discord application ID | Yes |
| `DISCORD_TOKEN` | Discord bot token | Yes |
| `PUBLIC_KEY` | Discord public key for verification | Yes |
| `DATABASE_URL` | PostgreSQL connection string | Yes (auto-set in Docker) |
| `PORT` | HTTP server port | No (default: 3000) |
| `UMAMI_URL` | Umami analytics endpoint | No |
| `UMAMI_WEBSITE_ID` | Umami website identifier | No |
| `NODE_ENV` | Environment (production/development) | No |

### Discord Slash Commands

Commands are registered via `registerCommands.js`. Modify this file to add new commands or change options.

## 📊 Analytics

The bot includes optional Umami analytics integration to track:
- Command usage frequency
- Guild and user engagement
- Performance metrics

No personally identifiable information is sent to analytics.

## 🤝 Contributing

Contributions are welcome! Areas for improvement:

- Additional statistical ranking methods
- Enhanced OCR accuracy for different Wordle image formats
- Mobile app screenshot support
- Visualization of rating changes over time
- Tournament modes

## 📝 License

ISC License - See package.json for details

## 👤 Author

**Tomass Wilson**

- GitHub: [@Wilsontomass](https://github.com/Wilsontomass)
- Blog: [wilsoniumite.com](https://wilsoniumite.com)

## 🙏 Acknowledgments

- Elo rating methodology based on Newman 2023 paper on pairwise comparisons
- Inspired by the need for fair Wordle competition among friends
- Built with love for statistics and word games

## 📚 Further Reading

For a deep dive into the mathematical foundations of the leaderboard calculations, check out the detailed blog post: [Calculating a Wordle Leaderboard](https://wilsoniumite.com/2025/11/05/calculating-a-wordle-leaderboard/)

---

**Happy Wordling! 🎯**
