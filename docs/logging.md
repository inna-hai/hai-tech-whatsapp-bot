# Logging & Error Handling

## Log Structure

All logs follow a consistent JSON format for easy parsing and monitoring.

### Log Levels

| Level | Usage |
|-------|-------|
| DEBUG | Detailed debugging info (dev only) |
| INFO | Normal operations |
| WARN | Potential issues |
| ERROR | Errors that need attention |
| FATAL | Critical failures |

---

## Log Formats

### Incoming Message Log
```json
{
  "level": "INFO",
  "event": "message_received",
  "timestamp": "2026-02-26T12:00:00.000Z",
  "data": {
    "phone": "+972501234567",
    "conversation_id": "conv_abc123",
    "wa_message_id": "wamid.xxx",
    "message_length": 45,
    "is_new_conversation": false
  }
}
```

### Response Generated Log
```json
{
  "level": "INFO",
  "event": "response_generated",
  "timestamp": "2026-02-26T12:00:01.500Z",
  "data": {
    "conversation_id": "conv_abc123",
    "duration_ms": 1500,
    "tokens_used": 850,
    "model": "gpt-4o",
    "reply_length": 120
  }
}
```

### CRM Sync Log
```json
{
  "level": "INFO",
  "event": "crm_sync",
  "timestamp": "2026-02-26T12:10:00.000Z",
  "data": {
    "conversation_id": "conv_abc123",
    "sync_type": "lead_upsert",
    "crm_lead_id": "lead_xyz789",
    "idempotency_key": "conv_abc123_2026-02-26T12:00:00Z_8",
    "status": "success",
    "duration_ms": 450
  }
}
```

### Error Log
```json
{
  "level": "ERROR",
  "event": "processing_error",
  "timestamp": "2026-02-26T12:00:00.000Z",
  "data": {
    "conversation_id": "conv_abc123",
    "phone": "+972501234567",
    "error_type": "OpenAIError",
    "error_message": "Rate limit exceeded",
    "error_code": "rate_limit_exceeded",
    "stack": "..."
  }
}
```

---

## Error Handling Strategy

### Recoverable Errors

| Error | Handling |
|-------|----------|
| OpenAI rate limit | Retry with exponential backoff (3 attempts) |
| OpenAI timeout | Retry once, then fallback message |
| CRM sync failure | Queue for retry, max 3 attempts |
| DB connection lost | Reconnect, queue message |

### Non-Recoverable Errors

| Error | Handling |
|-------|----------|
| Invalid phone format | Log + ignore message |
| Malformed webhook | Return 400, log warning |
| Auth failure | Return 401, alert |

### Fallback Messages

When AI fails, send human-friendly fallback:
```
סליחה, משהו השתבש. נציג יחזור אליך בהקדם 🙏
```

---

## Monitoring & Alerts

### Metrics to Track

1. **Message Volume**
   - Messages per hour
   - Unique conversations per day
   - New vs returning users

2. **Performance**
   - Response latency (p50, p95, p99)
   - OpenAI token usage
   - Error rate

3. **Business**
   - Lead conversion rate
   - Sync success rate
   - Average messages per conversation

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Error rate | > 5% | > 10% |
| Response latency p95 | > 5s | > 10s |
| OpenAI errors/hour | > 10 | > 30 |
| CRM sync failures | > 5 | > 15 |

---

## Log Retention

| Log Type | Retention |
|----------|-----------|
| Message logs | 90 days |
| Error logs | 180 days |
| Sync logs | 30 days |
| Metrics | 365 days |

---

## Sample Queries

### Find failed syncs
```sql
SELECT * FROM sync_logs 
WHERE status = 'failed' 
AND created_at > datetime('now', '-24 hours')
ORDER BY created_at DESC;
```

### Get conversation stats
```sql
SELECT 
  DATE(created_at) as date,
  COUNT(DISTINCT conversation_id) as conversations,
  COUNT(*) as messages,
  AVG(tokens_used) as avg_tokens
FROM messages
WHERE created_at > datetime('now', '-7 days')
GROUP BY DATE(created_at);
```

### Find high-value leads
```sql
SELECT * FROM conversations
WHERE message_count > 5
AND lead_interests LIKE '%roblox%'
AND crm_synced_at IS NOT NULL
ORDER BY last_message_at DESC;
```
