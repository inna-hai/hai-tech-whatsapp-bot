# API Specification - WhatsApp Bot

## Architecture Overview

```
Client → WhatsApp → Make.com → OpenClaw API → Make.com → WhatsApp
                                    ↓
                               CRM (direct)
```

Make.com serves as a relay only. OpenClaw handles all AI logic.

---

## Endpoints

### POST /whatsapp/incoming

Receives incoming WhatsApp messages from Make.com webhook.

#### Request Headers
```
Content-Type: application/json
X-Webhook-Secret: <shared_secret>
```

#### Request Body
```json
{
  "phone": "+972501234567",
  "message": "היי, אשמח לשמוע על הקורסים",
  "wa_message_id": "wamid.xxx",
  "wa_timestamp": "2026-02-26T12:00:00Z",
  "contact_name": "משה ישראלי",
  "profile_name": "Moshe"
}
```

#### Response (Success - 200)
```json
{
  "reply": "היי משה! 👋 אשמח לעזור...",
  "conversation_id": "conv_abc123",
  "should_reply": true
}
```

#### Response (No Reply Needed - 200)
```json
{
  "reply": null,
  "conversation_id": "conv_abc123",
  "should_reply": false,
  "reason": "duplicate_message"
}
```

#### Response (Error - 500)
```json
{
  "error": "Failed to process message",
  "details": "OpenAI rate limit exceeded"
}
```

---

### GET /whatsapp/conversation/:phone

Get conversation context for a phone number.

#### Request
```
GET /whatsapp/conversation/+972501234567
Authorization: Bearer <api_key>
```

#### Response
```json
{
  "conversation_id": "conv_abc123",
  "phone_e164": "+972501234567",
  "lead": {
    "full_name": "משה ישראלי",
    "email": "moshe@example.com",
    "child_name": "דני",
    "child_age": 10,
    "interests": ["minecraft", "roblox"]
  },
  "summary": "הורה מתעניין בקורס מיינקראפט לבן בן 10",
  "message_count": 8,
  "first_message_at": "2026-02-26T10:00:00Z",
  "last_message_at": "2026-02-26T12:30:00Z",
  "crm_synced": true
}
```

---

### POST /whatsapp/sync/:conversation_id

Force CRM sync for a conversation (admin use).

#### Request
```
POST /whatsapp/sync/conv_abc123
Authorization: Bearer <api_key>
```

#### Response
```json
{
  "success": true,
  "crm_lead_id": "lead_xyz789",
  "activity_id": "act_456"
}
```

---

### GET /whatsapp/health

Health check endpoint.

#### Response
```json
{
  "status": "ok",
  "timestamp": "2026-02-26T12:00:00Z",
  "version": "1.0.0",
  "db_connected": true,
  "openai_available": true
}
```

---

## Webhook Format (Make.com → WhatsApp)

When OpenClaw returns a reply, Make.com should send to WhatsApp:

```json
{
  "messaging_product": "whatsapp",
  "to": "972501234567",
  "type": "text",
  "text": {
    "body": "היי! 👋 אשמח לעזור..."
  }
}
```

---

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Invalid request (missing phone, invalid format) |
| 401 | Unauthorized (invalid webhook secret) |
| 429 | Rate limited (too many requests) |
| 500 | Internal error |
| 503 | Service unavailable (OpenAI down) |

---

## Rate Limits

- Per phone: 60 messages/hour
- Global: 1000 messages/hour
- Sync: 100 syncs/hour

---

## Idempotency

All sync operations use `idempotency_key` based on:
```
${conversation_id}_${last_message_at}_${message_count}
```

This prevents duplicate CRM entries even if webhooks retry.
