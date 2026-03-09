/**
 * HAI-TECH WhatsApp Conversation Engine
 * Production server for handling WhatsApp messages via Make.com
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ========== Configuration ==========
const PORT = process.env.PORT || 18790;
const CONTEXT_LAST_N = parseInt(process.env.CONTEXT_LAST_N_MESSAGES) || 20;
const SYNC_IDLE_MINUTES = parseInt(process.env.SYNC_IDLE_MINUTES) || 10;
const DB_PATH = process.env.DATABASE_PATH || './data/bot.db';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// ========== Initialize Services ==========
const app = express();
app.use(cors());
app.use(express.json());

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Database
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Load knowledge base and system prompt
const knowledgeBase = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data/hai_tech_knowledge_base.json'), 'utf8')
);
const systemPromptBase = fs.readFileSync(
  path.join(__dirname, 'data/system_prompt.md'), 'utf8'
);

// ========== Database Setup ==========
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL UNIQUE,
      lead_full_name TEXT,
      lead_email TEXT,
      lead_child_name TEXT,
      lead_child_age INTEGER,
      lead_child_grade TEXT,
      lead_interests TEXT,
      lead_preferred_format TEXT,
      lead_type TEXT,
      rolling_summary TEXT,
      last_summary_at TEXT,
      crm_synced_at TEXT,
      crm_lead_id TEXT,
      crm_sync_status TEXT DEFAULT 'pending',
      first_message_at TEXT DEFAULT (datetime('now')),
      last_message_at TEXT DEFAULT (datetime('now')),
      last_user_message_at TEXT,
      message_count INTEGER DEFAULT 0,
      sync_due_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone_e164);
    CREATE INDEX IF NOT EXISTS idx_conversations_sync ON conversations(sync_due_at, crm_sync_status);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      wa_message_id TEXT,
      wa_timestamp TEXT,
      tokens_used INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      sync_type TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL,
      response_body TEXT,
      error_message TEXT,
      triggered_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  console.log('[DB] Database initialized');
}

initDatabase();

// ========== Make.com Webhook ==========
async function sendToMakeWebhook(phone, replyText, conversationId) {
  if (!MAKE_WEBHOOK_URL) {
    console.log('[Make] No webhook URL configured, skipping');
    return { success: false, reason: 'no_webhook_url' };
  }

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      phone: phone,
      reply_text: replyText,
      conversation_id: conversationId,
      timestamp: new Date().toISOString()
    });

    const webhookUrl = new URL(MAKE_WEBHOOK_URL);

    const options = {
      hostname: webhookUrl.hostname,
      port: 443,
      path: webhookUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const success = res.statusCode >= 200 && res.statusCode < 300;
        console.log(`[Make] Webhook sent - Status: ${res.statusCode}`);
        resolve({ success, statusCode: res.statusCode, body });
      });
    });

    req.on('error', (err) => {
      console.error('[Make] Webhook error:', err.message);
      resolve({ success: false, error: err.message });
    });

    req.write(postData);
    req.end();
  });
}

// ========== Helper Functions ==========
function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = '972' + digits.slice(1);
  }
  if (!digits.startsWith('972')) {
    digits = '972' + digits;
  }
  return '+' + digits;
}

function getOrCreateConversation(phone, contactName = null) {
  let conv = db.prepare('SELECT * FROM conversations WHERE phone_e164 = ?').get(phone);

  if (!conv) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO conversations (id, phone_e164, lead_full_name)
      VALUES (?, ?, ?)
    `).run(id, phone, contactName);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    console.log(`[Conv] Created new conversation: ${id} for ${phone}`);
  }

  return conv;
}

function storeMessage(conversationId, role, content, waMessageId = null, tokensUsed = null) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, wa_message_id, tokens_used)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, role, content, waMessageId, tokensUsed);

  // Keep only last N messages
  db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ?
    AND id NOT IN (
      SELECT id FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `).run(conversationId, conversationId, CONTEXT_LAST_N);

  return id;
}

function getConversationHistory(conversationId) {
  return db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(conversationId, CONTEXT_LAST_N);
}

function updateConversationAfterMessage(conversationId, isUserMessage = true) {
  const now = new Date().toISOString();
  const syncDueAt = new Date(Date.now() + SYNC_IDLE_MINUTES * 60 * 1000).toISOString();

  if (isUserMessage) {
    db.prepare(`
      UPDATE conversations
      SET message_count = message_count + 1,
          last_message_at = ?,
          last_user_message_at = ?,
          sync_due_at = ?,
          crm_sync_status = 'pending',
          updated_at = ?
      WHERE id = ?
    `).run(now, now, syncDueAt, now, conversationId);
  } else {
    db.prepare(`
      UPDATE conversations
      SET message_count = message_count + 1,
          last_message_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(now, now, conversationId);
  }
}

function buildSystemPrompt(conversation) {
  return `${systemPromptBase}

---
## Knowledge Base (מידע על דרך ההייטק)

${JSON.stringify(knowledgeBase, null, 2)}

---
## הקשר שיחה נוכחית

מספר טלפון: ${conversation.phone_e164}
${conversation.lead_full_name ? `שם: ${conversation.lead_full_name}` : ''}
${conversation.lead_child_name ? `שם הילד: ${conversation.lead_child_name}` : ''}
${conversation.lead_child_age ? `גיל הילד: ${conversation.lead_child_age}` : ''}
${conversation.rolling_summary ? `סיכום קודם: ${conversation.rolling_summary}` : ''}
`;
}

// ========== Routes ==========

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
    conversations: db.prepare('SELECT COUNT(*) as count FROM conversations').get().count,
    messages: db.prepare('SELECT COUNT(*) as count FROM messages').get().count
  });
});

// Metrics (optional)
app.get('/metrics', (req, res) => {
  const stats = {
    conversations_total: db.prepare('SELECT COUNT(*) as c FROM conversations').get().c,
    conversations_today: db.prepare(`
      SELECT COUNT(*) as c FROM conversations
      WHERE created_at > datetime('now', '-1 day')
    `).get().c,
    messages_total: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
    messages_today: db.prepare(`
      SELECT COUNT(*) as c FROM messages
      WHERE created_at > datetime('now', '-1 day')
    `).get().c,
    pending_syncs: db.prepare(`
      SELECT COUNT(*) as c FROM conversations
      WHERE crm_sync_status = 'pending' AND sync_due_at <= datetime('now')
    `).get().c,
    synced_today: db.prepare(`
      SELECT COUNT(*) as c FROM sync_logs
      WHERE status = 'success' AND created_at > datetime('now', '-1 day')
    `).get().c
  };
  res.json(stats);
});

// Main webhook endpoint
app.post('/whatsapp/incoming', async (req, res) => {
  const startTime = Date.now();

  try {
    const { from_phone, text, message_id, timestamp, contact_name } = req.body;

    if (!from_phone || !text) {
      return res.status(400).json({ error: 'Missing from_phone or text' });
    }

    const phone = normalizePhone(from_phone);
    console.log(`[Incoming] ${phone}: ${text.slice(0, 50)}...`);

    // Get or create conversation
    const conversation = getOrCreateConversation(phone, contact_name);

    // Check for duplicate
    if (message_id) {
      const existing = db.prepare('SELECT id FROM messages WHERE wa_message_id = ?').get(message_id);
      if (existing) {
        console.log(`[Incoming] Duplicate message ${message_id}, skipping`);
        return res.json({ reply_text: null, duplicate: true });
      }
    }

    // Store user message
    storeMessage(conversation.id, 'user', text, message_id);
    updateConversationAfterMessage(conversation.id, true);

    // Get history
    const history = getConversationHistory(conversation.id);

    // Refresh conversation data
    const freshConv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation.id);

    // Build messages for OpenAI
    const messages = [
      { role: 'system', content: buildSystemPrompt(freshConv) },
      ...history.map(m => ({ role: m.role, content: m.content }))
    ];

    // Generate response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      max_tokens: 500,
      temperature: 0.7
    });

    const replyText = completion.choices[0].message.content;
    const tokensUsed = completion.usage?.total_tokens || 0;

    // Store assistant message
    storeMessage(conversation.id, 'assistant', replyText, null, tokensUsed);
    updateConversationAfterMessage(conversation.id, false);

    const duration = Date.now() - startTime;
    console.log(`[Response] ${phone}: ${replyText.slice(0, 50)}... (${duration}ms, ${tokensUsed} tokens)`);

    // Send reply to Make.com webhook (async, don't wait)
    sendToMakeWebhook(phone, replyText, conversation.id).catch(err => {
      console.error('[Make] Failed to send webhook:', err.message);
    });

    res.json({
      reply_text: replyText,
      conversation_id: conversation.id,
      tokens_used: tokensUsed,
      duration_ms: duration
    });

  } catch (error) {
    console.error('[Error]', error);
    res.json({
      reply_text: 'סליחה, משהו השתבש. נציג יחזור אליך בהקדם 🙏',
      error: error.message
    });
  }
});

// Get conversation (for debugging)
app.get('/conversation/:phone', (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const conv = db.prepare('SELECT * FROM conversations WHERE phone_e164 = ?').get(phone);

  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const messages = getConversationHistory(conv.id);
  res.json({ conversation: conv, messages });
});

// ========== CRM Integration ==========
const CRM_CONFIG = {
  endpoint: 'https://crm.orma-ai.com/api/webhook/leads',
  apiKey: '9d75edbf83df79261c4f9bd8b3943f18338854d1fc3e7cbd1fece3df17825f9a'
};

async function sendToCRM(leadData) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(leadData);
    const crmUrl = new URL(CRM_CONFIG.endpoint);

    const options = {
      hostname: crmUrl.hostname,
      port: 443,
      path: crmUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CRM_CONFIG.apiKey,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const success = res.statusCode >= 200 && res.statusCode < 300;
        console.log(`[CRM] Lead sent - Status: ${res.statusCode}`);
        resolve({ success, statusCode: res.statusCode, body });
      });
    });

    req.on('error', (err) => {
      console.error('[CRM] Error:', err.message);
      resolve({ success: false, error: err.message });
    });

    req.write(postData);
    req.end();
  });
}

// ========== CRM Sync Worker ==========
async function runSyncWorker() {
  const now = new Date().toISOString();

  // Find conversations due for sync
  const pending = db.prepare(`
    SELECT * FROM conversations
    WHERE crm_sync_status = 'pending'
    AND sync_due_at <= ?
    AND last_user_message_at IS NOT NULL
    LIMIT 10
  `).all(now);

  if (pending.length === 0) return;

  console.log(`[SyncWorker] Found ${pending.length} conversations to sync`);

  for (const conv of pending) {
    try {
      await syncConversationToCRM(conv);
    } catch (error) {
      console.error(`[SyncWorker] Failed to sync ${conv.id}:`, error.message);
    }
  }
}

async function syncConversationToCRM(conversation) {
  const convId = conversation.id;
  console.log(`[SyncWorker] Syncing ${convId}...`);

  // Get messages
  const messages = db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(convId);

  if (messages.length === 0) {
    console.log(`[SyncWorker] No messages to sync for ${convId}`);
    return;
  }

  // Generate idempotency key
  const idempotencyKey = `${convId}_${conversation.last_user_message_at}_${conversation.message_count}`;

  // Check if already synced
  const existing = db.prepare(`
    SELECT id FROM sync_logs WHERE idempotency_key = ? AND status = 'success'
  `).get(idempotencyKey);

  if (existing) {
    console.log(`[SyncWorker] Already synced with key ${idempotencyKey}`);
    db.prepare(`UPDATE conversations SET crm_sync_status = 'synced' WHERE id = ?`).run(convId);
    return;
  }

  // Generate summary using OpenAI
  const conversationText = messages.map(m =>
    `${m.role === 'user' ? 'לקוח' : 'נציג'}: ${m.content}`
  ).join('\n');

  const summaryResponse = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `אתה מנתח שיחות של דרך ההייטק. חלץ מידע על הליד וצור סיכום.
החזר JSON בלבד בפורמט:
{
  "lead": {
    "full_name": "שם או null",
    "email": "מייל או null",
    "child_name": "שם הילד או null",
    "child_age": null או מספר,
    "interests": ["minecraft", "roblox", ...],
    "lead_type": "parent/institution/teacher/other"
  },
  "summary_short": "סיכום בשורה אחת",
  "summary_bullets": ["נקודה 1", "נקודה 2"],
  "tags": ["תגיות"],
  "recommended_action": "call_back/send_info/wait"
}`
      },
      { role: 'user', content: `נתח את השיחה:\n\n${conversationText}` }
    ],
    response_format: { type: 'json_object' }
  });

  let syncData;
  try {
    syncData = JSON.parse(summaryResponse.choices[0].message.content);
  } catch (e) {
    console.error('[SyncWorker] Failed to parse summary:', e);
    syncData = { lead: {}, summary_short: 'שיחת וואטסאפ', summary_bullets: [], tags: [] };
  }

  // Extract lead data first
  const lead = syncData.lead || {};
  
  // Log sync attempt (delete old pending entries first)
  db.prepare(`DELETE FROM sync_logs WHERE idempotency_key = ? AND status != 'success'`).run(idempotencyKey);
  
  const syncLogId = uuidv4();
  db.prepare(`
    INSERT INTO sync_logs (id, conversation_id, idempotency_key, sync_type, payload, status, triggered_at)
    VALUES (?, ?, ?, 'lead_upsert', ?, 'pending', datetime('now'))
  `).run(syncLogId, convId, idempotencyKey, JSON.stringify(syncData));

  // Log summary
  console.log(`[SyncWorker] Summary for ${conversation.phone_e164}:`);
  console.log(`  - ${syncData.summary_short}`);
  console.log(`  - Tags: ${syncData.tags?.join(', ')}`);
  console.log(`  - Action: ${syncData.recommended_action}`);

  // Send to Orma CRM
  const crmResult = await sendToCRM({
    name: lead.full_name || 'ליד מוואטסאפ',
    phone: conversation.phone_e164,
    email: lead.email || '',
    notes: `📱 שיחת וואטסאפ\n\n${syncData.summary_short}\n\n📋 פרטים:\n${syncData.summary_bullets?.map(b => '• ' + b).join('\n') || ''}\n\n🏷️ תגיות: ${syncData.tags?.join(', ') || ''}\n\n💡 פעולה מומלצת: ${syncData.recommended_action || 'לא צוין'}`,
    source: 'whatsapp'
  });

  if (crmResult.success) {
    console.log(`[SyncWorker] Lead sent to CRM: ${conversation.phone_e164}`);
  } else {
    console.error(`[SyncWorker] CRM Error: ${crmResult.error}`);
  }

  // Update conversation with extracted data
  db.prepare(`
    UPDATE conversations SET
      lead_full_name = COALESCE(?, lead_full_name),
      lead_email = COALESCE(?, lead_email),
      lead_child_name = COALESCE(?, lead_child_name),
      lead_child_age = COALESCE(?, lead_child_age),
      lead_interests = ?,
      lead_type = ?,
      rolling_summary = ?,
      crm_synced_at = datetime('now'),
      crm_sync_status = 'synced',
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    lead.full_name, lead.email, lead.child_name, lead.child_age,
    JSON.stringify(lead.interests || []),
    lead.lead_type,
    syncData.summary_short,
    convId
  );

  // Update sync log
  db.prepare(`
    UPDATE sync_logs SET status = 'success', completed_at = datetime('now')
    WHERE id = ?
  `).run(syncLogId);

  console.log(`[SyncWorker] Successfully synced ${convId}`);
}

// Run sync worker every minute
cron.schedule('* * * * *', () => {
  runSyncWorker().catch(err => console.error('[SyncWorker] Error:', err));
});

// ========== Start Server ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🤖 HAI-TECH WhatsApp Conversation Engine                  ║
║                                                            ║
║  Port: ${PORT}                                              ║
║  Health: http://localhost:${PORT}/health                    ║
║  Webhook: POST http://localhost:${PORT}/whatsapp/incoming   ║
║                                                            ║
║  Sync idle time: ${SYNC_IDLE_MINUTES} minutes                               ║
║  Context messages: ${CONTEXT_LAST_N}                                     ║
╚════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  db.close();
  process.exit(0);
});
