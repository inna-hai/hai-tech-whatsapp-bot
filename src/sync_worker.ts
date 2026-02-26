/**
 * CRM Sync Worker
 * 
 * Triggered 10 minutes after last message in a conversation.
 * Generates summary, extracts lead data, syncs to CRM.
 */

import { OpenAI } from 'openai';

// Types
interface Lead {
  full_name?: string;
  phone: string;
  email?: string;
  child_name?: string;
  child_age?: number;
  child_grade?: string;
  interests?: string[];
  preferred_format?: 'digital' | 'private' | 'pair' | 'institution' | 'unknown';
  lead_type?: 'parent' | 'institution' | 'teacher' | 'other';
}

interface ConversationSummary {
  summary_short: string;
  summary_structured: {
    topic: string;
    child_details?: string;
    interests?: string;
    questions_asked: string[];
    recommendations_given: string[];
    next_steps?: string;
    open_questions: string[];
  };
  tags: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'hesitant';
  urgency: 'high' | 'medium' | 'low';
  recommended_action: 'call_back' | 'send_info' | 'schedule_demo' | 'wait' | 'close';
}

interface SyncPayload {
  lead: Lead;
  summary: ConversationSummary;
  metadata: {
    conversation_id: string;
    phone_e164: string;
    message_count: number;
    first_message_at: string;
    last_message_at: string;
    source: 'whatsapp';
    answered_by_bot: boolean;
    idempotency_key: string;
  };
}

// Configuration
const SYNC_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SYNC_ATTEMPTS = 3;

/**
 * Main sync worker - runs on interval or cron
 */
export async function runSyncWorker(db: any, openai: OpenAI, crmClient: any): Promise<void> {
  console.log('[SyncWorker] Starting sync cycle...');
  
  // Find conversations ready for sync
  const pendingConversations = await db.query(`
    SELECT c.*, sq.attempts
    FROM conversations c
    JOIN sync_queue sq ON c.id = sq.conversation_id
    WHERE sq.status = 'pending'
      AND sq.scheduled_for <= datetime('now')
      AND sq.attempts < ?
    ORDER BY sq.scheduled_for ASC
    LIMIT 10
  `, [MAX_SYNC_ATTEMPTS]);

  console.log(`[SyncWorker] Found ${pendingConversations.length} conversations to sync`);

  for (const conversation of pendingConversations) {
    try {
      await syncConversation(db, openai, crmClient, conversation);
    } catch (error) {
      console.error(`[SyncWorker] Failed to sync ${conversation.id}:`, error);
      await incrementSyncAttempts(db, conversation.id);
    }
  }
}

/**
 * Sync a single conversation to CRM
 */
async function syncConversation(
  db: any, 
  openai: OpenAI, 
  crmClient: any, 
  conversation: any
): Promise<void> {
  const conversationId = conversation.id;
  console.log(`[SyncWorker] Processing conversation ${conversationId}`);

  // Mark as processing
  await db.run(`
    UPDATE sync_queue SET status = 'processing', updated_at = datetime('now')
    WHERE conversation_id = ?
  `, [conversationId]);

  // Get messages
  const messages = await db.query(`
    SELECT role, content, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
    LIMIT 20
  `, [conversationId]);

  // Generate idempotency key
  const idempotencyKey = `${conversationId}_${conversation.last_message_at}_${conversation.message_count}`;

  // Check if already synced with this key
  const existingSync = await db.get(`
    SELECT id FROM sync_logs WHERE idempotency_key = ? AND status = 'success'
  `, [idempotencyKey]);

  if (existingSync) {
    console.log(`[SyncWorker] Already synced with key ${idempotencyKey}, skipping`);
    await markSyncComplete(db, conversationId);
    return;
  }

  // Generate summary and extract lead using OpenAI
  const { lead, summary } = await generateSummaryAndExtractLead(openai, messages, conversation);

  // Build sync payload
  const payload: SyncPayload = {
    lead: {
      ...lead,
      phone: conversation.phone_e164
    },
    summary,
    metadata: {
      conversation_id: conversationId,
      phone_e164: conversation.phone_e164,
      message_count: conversation.message_count,
      first_message_at: conversation.first_message_at,
      last_message_at: conversation.last_message_at,
      source: 'whatsapp',
      answered_by_bot: true,
      idempotency_key: idempotencyKey
    }
  };

  // Log sync attempt
  const syncLogId = crypto.randomUUID();
  await db.run(`
    INSERT INTO sync_logs (id, conversation_id, idempotency_key, sync_type, payload, status, triggered_at)
    VALUES (?, ?, ?, 'lead_upsert', ?, 'pending', datetime('now'))
  `, [syncLogId, conversationId, idempotencyKey, JSON.stringify(payload)]);

  try {
    // Upsert lead in CRM
    const crmResponse = await crmClient.upsertLead({
      phone: payload.lead.phone,
      name: payload.lead.full_name,
      email: payload.lead.email,
      custom_fields: {
        child_name: payload.lead.child_name,
        child_age: payload.lead.child_age,
        interests: payload.lead.interests?.join(', '),
        lead_type: payload.lead.lead_type,
        source: 'whatsapp',
        answered_by_bot: true,
        status: 'contacted_on_whatsapp'
      }
    });

    // Add activity with summary
    await crmClient.addActivity({
      lead_id: crmResponse.lead_id,
      type: 'whatsapp_conversation',
      subject: `שיחת וואטסאפ: ${payload.summary.summary_short}`,
      description: formatActivityDescription(payload.summary),
      tags: payload.summary.tags
    });

    // Update sync log as success
    await db.run(`
      UPDATE sync_logs 
      SET status = 'success', response_code = 200, completed_at = datetime('now')
      WHERE id = ?
    `, [syncLogId]);

    // Update conversation with CRM ID
    await db.run(`
      UPDATE conversations 
      SET crm_synced_at = datetime('now'), 
          crm_lead_id = ?,
          crm_sync_status = 'synced',
          rolling_summary = ?,
          lead_full_name = ?,
          lead_email = ?,
          lead_child_name = ?,
          lead_child_age = ?,
          lead_interests = ?
      WHERE id = ?
    `, [
      crmResponse.lead_id,
      payload.summary.summary_short,
      payload.lead.full_name,
      payload.lead.email,
      payload.lead.child_name,
      payload.lead.child_age,
      JSON.stringify(payload.lead.interests),
      conversationId
    ]);

    await markSyncComplete(db, conversationId);
    console.log(`[SyncWorker] Successfully synced ${conversationId} to CRM`);

  } catch (error: any) {
    // Update sync log as failed
    await db.run(`
      UPDATE sync_logs 
      SET status = 'failed', error_message = ?, completed_at = datetime('now')
      WHERE id = ?
    `, [error.message, syncLogId]);

    throw error;
  }
}

/**
 * Generate summary and extract lead data using OpenAI
 */
async function generateSummaryAndExtractLead(
  openai: OpenAI,
  messages: any[],
  conversation: any
): Promise<{ lead: Lead; summary: ConversationSummary }> {
  
  const conversationText = messages
    .map(m => `${m.role === 'user' ? 'לקוח' : 'נציג'}: ${m.content}`)
    .join('\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `אתה מנתח שיחות של דרך ההייטק. חלץ מידע על הליד וצור סיכום.

החזר JSON בפורמט הבא:
{
  "lead": {
    "full_name": "שם מלא או null",
    "email": "מייל או null",
    "child_name": "שם הילד או null",
    "child_age": "גיל מספר או null",
    "child_grade": "כיתה או null",
    "interests": ["minecraft", "roblox", ...],
    "preferred_format": "digital/private/pair/institution/unknown",
    "lead_type": "parent/institution/teacher/other"
  },
  "summary": {
    "summary_short": "סיכום בשורה אחת",
    "summary_structured": {
      "topic": "נושא השיחה",
      "child_details": "פרטים על הילד",
      "interests": "תחומי עניין",
      "questions_asked": ["שאלות שנשאלו"],
      "recommendations_given": ["המלצות שניתנו"],
      "next_steps": "צעדים הבאים",
      "open_questions": ["שאלות פתוחות"]
    },
    "tags": ["תגיות רלוונטיות"],
    "sentiment": "positive/neutral/negative/hesitant",
    "urgency": "high/medium/low",
    "recommended_action": "call_back/send_info/schedule_demo/wait/close"
  }
}`
      },
      {
        role: 'user',
        content: `נתח את השיחה הבאה:\n\n${conversationText}`
      }
    ],
    response_format: { type: 'json_object' }
  });

  const result = JSON.parse(response.choices[0].message.content || '{}');
  return result;
}

/**
 * Format activity description for CRM
 */
function formatActivityDescription(summary: ConversationSummary): string {
  const lines = [
    `📝 סיכום: ${summary.summary_short}`,
    '',
    `📌 נושא: ${summary.summary_structured.topic}`,
  ];

  if (summary.summary_structured.child_details) {
    lines.push(`👦 פרטי ילד: ${summary.summary_structured.child_details}`);
  }

  if (summary.summary_structured.interests) {
    lines.push(`🎯 תחומי עניין: ${summary.summary_structured.interests}`);
  }

  if (summary.summary_structured.questions_asked.length > 0) {
    lines.push('', '❓ שאלות שנשאלו:');
    summary.summary_structured.questions_asked.forEach(q => lines.push(`  • ${q}`));
  }

  if (summary.summary_structured.recommendations_given.length > 0) {
    lines.push('', '💡 המלצות שניתנו:');
    summary.summary_structured.recommendations_given.forEach(r => lines.push(`  • ${r}`));
  }

  if (summary.summary_structured.next_steps) {
    lines.push('', `➡️ צעדים הבאים: ${summary.summary_structured.next_steps}`);
  }

  if (summary.summary_structured.open_questions.length > 0) {
    lines.push('', '⏳ שאלות פתוחות:');
    summary.summary_structured.open_questions.forEach(q => lines.push(`  • ${q}`));
  }

  lines.push('', `🏷️ תגיות: ${summary.tags.join(', ')}`);
  lines.push(`📊 הרגשה: ${summary.sentiment} | דחיפות: ${summary.urgency}`);
  lines.push(`🎬 פעולה מומלצת: ${summary.recommended_action}`);

  return lines.join('\n');
}

/**
 * Mark sync as complete
 */
async function markSyncComplete(db: any, conversationId: string): Promise<void> {
  await db.run(`
    UPDATE sync_queue 
    SET status = 'completed', processed_at = datetime('now'), updated_at = datetime('now')
    WHERE conversation_id = ?
  `, [conversationId]);
}

/**
 * Increment sync attempts on failure
 */
async function incrementSyncAttempts(db: any, conversationId: string): Promise<void> {
  await db.run(`
    UPDATE sync_queue 
    SET attempts = attempts + 1, 
        status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
        updated_at = datetime('now')
    WHERE conversation_id = ?
  `, [MAX_SYNC_ATTEMPTS, conversationId]);
}

/**
 * Schedule sync for a conversation (called after each message)
 */
export async function scheduleSyncForConversation(db: any, conversationId: string): Promise<void> {
  const scheduledFor = new Date(Date.now() + SYNC_DELAY_MS).toISOString();
  
  await db.run(`
    INSERT INTO sync_queue (id, conversation_id, scheduled_for, status)
    VALUES (?, ?, ?, 'pending')
    ON CONFLICT (conversation_id) DO UPDATE SET
      scheduled_for = ?,
      status = 'pending',
      updated_at = datetime('now')
  `, [crypto.randomUUID(), conversationId, scheduledFor, scheduledFor]);
}
