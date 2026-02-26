# 🤖 WhatsApp AI Bot - דרך ההייטק

בוט וואטסאפ חכם לשירות לקוחות ואיסוף לידים עבור דרך ההייטק.

## 📁 מבנה הפרויקט

```
hai-tech-whatsapp-bot/
├── README.md
├── data/
│   ├── hai_tech_knowledge_base.json    # מאגר ידע מהאתר
│   ├── system_prompt.md                 # Prompt למודל
│   └── schemas.json                     # JSON schemas
├── src/
│   ├── handler.ts                       # Main message handler
│   └── sync_worker.ts                   # CRM sync worker
└── docs/
    ├── api_spec.md                      # API specification
    ├── database_schema.sql              # DB structure
    └── logging.md                       # Log & error handling
```

## ✅ Definition of Done

| Requirement | Status |
|-------------|--------|
| הבוט עונה מדויק לפי האתר | ✅ Knowledge Base מלא |
| שומר קונטקסט מלא | ✅ DB + rolling summary |
| אוסף לידים בצורה טבעית | ✅ Extraction schema |
| מסנכרן ל-CRM אחרי 10 דקות | ✅ Sync worker |
| יוצר סיכום איכותי לכל שיחה | ✅ Summary schema |

## 🏗️ Architecture

```
WhatsApp → Make.com → OpenClaw API → OpenAI
              ↓              ↓
         WhatsApp        CRM (direct)
```

## 📦 Deliverables

### 1. Knowledge Base (`data/hai_tech_knowledge_base.json`)
- פרטי החברה והמייסדים
- כל הקורסים הדיגיטליים
- חבילות שיעורים פרטיים
- תוכניות למוסדות
- שאלות נפוצות
- המלצות לקוחות

### 2. System Prompt (`data/system_prompt.md`)
- זהות הבוט וטון
- כללי התנהגות (DO/DON'T)
- זיהוי קהל יעד
- זרימת שיחה מומלצת
- דוגמאות לתגובות

### 3. Schemas (`data/schemas.json`)
- Lead extraction schema
- Conversation summary schema
- CRM sync payload schema

### 4. Database (`docs/database_schema.sql`)
- conversations table
- messages table
- sync_logs table
- sync_queue table

### 5. Sync Worker (`src/sync_worker.ts`)
- 10-minute idle trigger
- Lead extraction via GPT
- Summary generation
- CRM upsert with idempotency
- Activity creation

### 6. API Spec (`docs/api_spec.md`)
- POST /whatsapp/incoming
- GET /whatsapp/conversation/:phone
- POST /whatsapp/sync/:id
- Error codes & rate limits

### 7. Logging (`docs/logging.md`)
- Log formats
- Error handling strategy
- Monitoring & alerts
- Retention policy

## 🚀 Next Steps

1. **Setup Make.com Scenario**
   - WhatsApp Business webhook → HTTP call to OpenClaw
   - OpenClaw response → WhatsApp send

2. **Deploy OpenClaw Worker**
   - Configure environment variables
   - Set up SQLite/PostgreSQL
   - Load knowledge base

3. **Configure CRM Integration**
   - API credentials
   - Field mapping
   - Webhook for activities

4. **Testing**
   - Unit tests for handler
   - Integration tests for sync
   - Load testing

## ⚠️ Constraints

- אין להמציא מידע שלא מופיע באתר
- אין להציע מחירים שלא מוגדרים
- אין לשמור מידע רגיש מעבר לנדרש
- עברית תקינה בלבד

## 📞 Contact

- WhatsApp: 972533009742
- Website: https://hai.tech
