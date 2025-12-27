CREATE TABLE IF NOT EXISTS wordle_results (
    user_id_hash VARCHAR(64) NOT NULL,
    wordle_number INTEGER NOT NULL,
    completed_at TIMESTAMP NOT NULL,
    score INTEGER NOT NULL CHECK (score >= 1 AND score <= 7),
    channel_id BIGINT NOT NULL DEFAULT 0,
    message_id BIGINT,
    PRIMARY KEY (user_id_hash, wordle_number, channel_id)
);

-- Index for querying by wordle number range
CREATE INDEX IF NOT EXISTS idx_wordle_number ON wordle_results(wordle_number);

-- Index for user queries
CREATE INDEX IF NOT EXISTS idx_user_id_hash ON wordle_results(user_id_hash);

-- Index for channel-specific queries
CREATE INDEX IF NOT EXISTS idx_channel_wordle ON wordle_results(channel_id, wordle_number);

-- Index for message lookups (NOT unique - same message can have multiple users!)
CREATE INDEX IF NOT EXISTS idx_message_id ON wordle_results(message_id) 
WHERE message_id IS NOT NULL;