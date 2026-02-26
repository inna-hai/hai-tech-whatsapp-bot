/**
 * WhatsApp Incoming Message Handler
 * 
 * Main entry point for processing WhatsApp messages.
 * Maintains conversation context and generates AI responses.
 */

import { OpenAI } from 'openai';
import { scheduleSyncForConversation } from './sync_worker';

// Types
interface IncomingMessage {
  phone: string;
  message: string;
  wa_message_id: string;
  wa_timestamp: string;
  contact_name?: string;
  profile_name?: string;
}

interface HandlerResponse {
  reply: string | null;
  conversation_id: string;
  should_reply: boolean;
  reason?: string;
}

// Configuration
const MAX_MESSAGES_CONTEXT = 20;
const RATE_LIMIT_PER_PHONE = 60; // per hour

/**
 * Main handler for incoming WhatsApp messages
 */
export async function handleIncomingMessage(
  db: any,
  openai: OpenAI,
  knowledgeBase: any,
  systemPrompt: string,
  message: IncomingMessage
): Promise<HandlerResponse> {
  
  const startTime = Date.now();
  const phone = normalizePhone(message.phone);
  
  console.log(`[Handler] Processing message from ${phone}`);

  try {
    // Rate limiting
    if (await isRateLimited(db, phone)) {
      console.log(`[Handler] Rate limited: ${phone}`);
      return {
        reply: null,
        conversation_id: '',
        should_reply: false,
        reason: 'rate_limited'
      };
    }

    // Get or create conversation
    let conversation = await getOrCreateConversation(db, phone, message);
    
    // Check for duplicate message
    if (await isDuplicateMessage(db, message.wa_message_id)) {
      console.log(`[Handler] Duplicate message: ${message.wa_message_id}`);
      return {
        reply: null,
        conversation_id: conversation.id,
        should_reply: false,
        reason: 'duplicate_message'
      };
    }

    // Store incoming message
    await storeMessage(db, conversation.id, 'user', message.message, message);

    // Get conversation history
    const history = await getConversationHistory(db, conversation.id);

    // Build messages for OpenAI
    const openaiMessages = buildOpenAIMessages(
      systemPrompt, 
      knowledgeBase, 
      history, 
      conversation
    );

    // Generate response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: openaiMessages,
      max_tokens: 500,
      temperature: 0.7
    });

    const reply = completion.choices[0].message.content || '';
    const tokensUsed = completion.usage?.total_tokens || 0;

    // Store assistant message
    await storeMessage(db, conversation.id, 'assistant', reply, null, tokensUsed);

    // Update conversation stats
    await updateConversationStats(db, conversation.id);

    // Schedule CRM sync (10 minutes after last message)
    await scheduleSyncForConversation(db, conversation.id);

    // Log metrics
    const duration = Date.now() - startTime;
    console.log(`[Handler] Response generated in ${duration}ms, ${tokensUsed} tokens`);

    return {
      reply,
      conversation_id: conversation.id,
      should_reply: true
    };

  } catch (error: any) {
    console.error(`[Handler] Error processing message:`, error);
    
    // Log error
    await logError(db, phone, message, error);

    // Return friendly error message
    return {
      reply: 'סליחה, משהו השתבש. נציג יחזור אליך בהקדם 🙏',
      conversation_id: '',
      should_reply: true
    };
  }
}

/**
 * Normalize phone number to E.164 format
 */
function normalizePhone(phone: string): string {
  // Remove all non-digits
  let digits = phone.replace(/\D/g, '');
  
  // Add Israel country code if missing
  if (digits.startsWith('0')) {
    digits = '972' + digits.slice(1);
  }
  
  // Ensure + prefix
  return '+' + digits;
}

/**
 * Get or create conversation for phone
 */
async function getOrCreateConversation(db: any, phone: string, message: IncomingMessage): Promise<any> {
  let conversation = await db.get(`
    SELECT * FROM conversations WHERE phone_e164 = ?
  `, [phone]);

  if (!conversation) {
    const id = crypto.randomUUID();
    await db.run(`
      INSERT INTO conversations (id, phone_e164, lead_full_name)
      VALUES (?, ?, ?)
    `, [id, phone, message.contact_name || message.profile_name || null]);
    
    conversation = { id, phone_e164: phone };
    console.log(`[Handler] Created new conversation: ${id}`);
  }

  return conversation;
}

/**
 * Check if message is duplicate
 */
async function isDuplicateMessage(db: any, waMessageId: string): Promise<boolean> {
  if (!waMessageId) return false;
  
  const existing = await db.get(`
    SELECT id FROM messages WHERE wa_message_id = ?
  `, [waMessageId]);
  
  return !!existing;
}

/**
 * Store message in database
 */
async function storeMessage(
  db: any, 
  conversationId: string, 
  role: 'user' | 'assistant', 
  content: string,
  waMetadata?: IncomingMessage | null,
  tokensUsed?: number
): Promise<void> {
  const id = crypto.randomUUID();
  
  await db.run(`
    INSERT INTO messages (id, conversation_id, role, content, wa_message_id, wa_timestamp, tokens_used)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    conversationId,
    role,
    content,
    waMetadata?.wa_message_id || null,
    waMetadata?.wa_timestamp || null,
    tokensUsed || null
  ]);

  // Cleanup old messages (keep last 20)
  await db.run(`
    DELETE FROM messages 
    WHERE conversation_id = ? 
    AND id NOT IN (
      SELECT id FROM messages 
      WHERE conversation_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    )
  `, [conversationId, conversationId, MAX_MESSAGES_CONTEXT]);
}

/**
 * Get conversation history
 */
async function getConversationHistory(db: any, conversationId: string): Promise<any[]> {
  return await db.query(`
    SELECT role, content, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `, [conversationId, MAX_MESSAGES_CONTEXT]);
}

/**
 * Build OpenAI messages array
 */
function buildOpenAIMessages(
  systemPrompt: string,
  knowledgeBase: any,
  history: any[],
  conversation: any
): any[] {
  const messages: any[] = [];

  // System prompt with knowledge base
  const fullSystemPrompt = `${systemPrompt}

---
## Knowledge Base (מידע על דרך ההייטק)

${JSON.stringify(knowledgeBase, null, 2)}

---
## הקשר שיחה

מספר טלפון: ${conversation.phone_e164}
${conversation.lead_full_name ? `שם: ${conversation.lead_full_name}` : ''}
${conversation.rolling_summary ? `סיכום קודם: ${conversation.rolling_summary}` : ''}
`;

  messages.push({
    role: 'system',
    content: fullSystemPrompt
  });

  // Add conversation history
  for (const msg of history.slice(-15)) { // Last 15 messages for context
    messages.push({
      role: msg.role,
      content: msg.content
    });
  }

  return messages;
}

/**
 * Update conversation statistics
 */
async function updateConversationStats(db: any, conversationId: string): Promise<void> {
  await db.run(`
    UPDATE conversations 
    SET message_count = message_count + 2,
        last_message_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `, [conversationId]);
}

/**
 * Check rate limiting
 */
async function isRateLimited(db: any, phone: string): Promise<boolean> {
  const result = await db.get(`
    SELECT COUNT(*) as count
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE c.phone_e164 = ?
    AND m.created_at > datetime('now', '-1 hour')
    AND m.role = 'user'
  `, [phone]);

  return result.count >= RATE_LIMIT_PER_PHONE;
}

/**
 * Log error to database
 */
async function logError(db: any, phone: string, message: IncomingMessage, error: any): Promise<void> {
  // Could store in error_logs table or external monitoring
  console.error('[Handler] Error details:', {
    phone,
    message: message.message?.slice(0, 100),
    error: error.message,
    stack: error.stack
  });
}
