CREATE TABLE IF NOT EXISTS wordle_results (
    user_id_hash VARCHAR(64) NOT NULL,
    wordle_number INTEGER NOT NULL,
    completed_at TIMESTAMP NOT NULL,
    score INTEGER NOT NULL CHECK (score >= 1 AND score <= 7),
    PRIMARY KEY (user_id_hash, wordle_number)
);

-- Index for querying by wordle number range
CREATE INDEX IF NOT EXISTS idx_wordle_number ON wordle_results(wordle_number);

-- Index for user queries
CREATE INDEX IF NOT EXISTS idx_user_id_hash ON wordle_results(user_id_hash);