-- =====================================================
-- HAI-TECH WhatsApp Bot Database Schema
-- SQLite / PostgreSQL compatible
-- =====================================================

-- -----------------------------------------------------
-- Table: conversations
-- Stores conversation metadata per phone number
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    phone_e164 TEXT NOT NULL UNIQUE,
    
    -- Lead fields (extracted from conversation)
    lead_full_name TEXT,
    lead_email TEXT,
    lead_child_name TEXT,
    lead_child_age INTEGER,
    lead_child_grade TEXT,
    lead_interests TEXT, -- JSON array
    lead_preferred_format TEXT, -- digital/private/pair/institution
    lead_type TEXT, -- parent/institution/teacher/other
    
    -- Conversation state
    rolling_summary TEXT, -- AI-generated running summary
    last_summary_at TIMESTAMP,
    
    -- Sync state
    crm_synced_at TIMESTAMP,
    crm_lead_id TEXT,
    crm_sync_status TEXT, -- pending/synced/failed
    
    -- Metadata
    first_message_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_conversations_phone ON conversations(phone_e164);
CREATE INDEX idx_conversations_last_message ON conversations(last_message_at);
CREATE INDEX idx_conversations_sync_status ON conversations(crm_sync_status);

-- -----------------------------------------------------
-- Table: messages
-- Stores individual messages (last 20 per conversation)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    
    role TEXT NOT NULL, -- 'user' or 'assistant'
    content TEXT NOT NULL,
    
    -- WhatsApp metadata
    wa_message_id TEXT,
    wa_timestamp TIMESTAMP,
    
    -- Processing metadata
    tokens_used INTEGER,
    model_used TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);

-- -----------------------------------------------------
-- Table: sync_logs
-- Tracks CRM sync attempts for idempotency
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_logs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    
    -- Sync details
    sync_type TEXT NOT NULL, -- 'lead_create', 'lead_update', 'activity_add'
    payload TEXT, -- JSON payload sent
    
    -- Response
    status TEXT NOT NULL, -- 'success', 'failed', 'pending'
    response_code INTEGER,
    response_body TEXT,
    error_message TEXT,
    
    -- Timing
    triggered_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_sync_logs_idempotency ON sync_logs(idempotency_key);
CREATE INDEX idx_sync_logs_status ON sync_logs(status);

-- -----------------------------------------------------
-- Table: sync_queue
-- Queue for pending CRM syncs (triggered after 10min idle)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    
    -- Scheduling
    scheduled_for TIMESTAMP NOT NULL, -- last_message_at + 10 minutes
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    
    -- Status
    status TEXT DEFAULT 'pending', -- pending/processing/completed/failed
    processed_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_sync_queue_scheduled ON sync_queue(scheduled_for, status);

-- -----------------------------------------------------
-- View: conversations_with_pending_sync
-- Helper view for sync worker
-- -----------------------------------------------------
CREATE VIEW IF NOT EXISTS conversations_pending_sync AS
SELECT 
    c.*,
    sq.scheduled_for,
    sq.attempts
FROM conversations c
JOIN sync_queue sq ON c.id = sq.conversation_id
WHERE sq.status = 'pending'
  AND sq.scheduled_for <= CURRENT_TIMESTAMP
  AND sq.attempts < sq.max_attempts
ORDER BY sq.scheduled_for ASC;

-- -----------------------------------------------------
-- Trigger: Update timestamps
-- -----------------------------------------------------
CREATE TRIGGER IF NOT EXISTS update_conversation_timestamp 
AFTER UPDATE ON conversations
BEGIN
    UPDATE conversations 
    SET updated_at = CURRENT_TIMESTAMP 
    WHERE id = NEW.id;
END;

-- -----------------------------------------------------
-- Function: Cleanup old messages (keep last 20)
-- Run periodically or after insert
-- -----------------------------------------------------
-- For SQLite, use a separate cleanup query:
-- DELETE FROM messages 
-- WHERE id NOT IN (
--     SELECT id FROM messages 
--     WHERE conversation_id = ? 
--     ORDER BY created_at DESC 
--     LIMIT 20
-- ) AND conversation_id = ?;
