# HR Slack Agent Chatbot — Implementation Plan

> **Working name:** Policy Pony 🦄
> **Date:** March 3, 2026
> **Scope:** MVP only

---

## 1. Purpose & Success Criteria

The bot provides fast, consistent answers to HR and "who do I contact?" questions via Slack DMs, reducing HR ticket volume and enabling employee self-service.

**MVP success metrics:**
- High containment rate (questions resolved without a human)
- Accurate source citations (answers link to the originating policy doc)
- Active usage across employees
- Low hallucination rate (answers only from approved uploaded documents)
- Weekly unanswered-questions digest delivered to `#policy-pony-slack-chatbot`

---

## 2. MVP Feature Set

### 2.1 HR FAQ with Citations
- Answer employee questions using content from HR-uploaded policy documents
- Every answer includes a citation (document name + section where possible)
- If the answer is not found in any uploaded document, respond with a clear "I don't know, please contact HR" message
- Hallucination guard: the bot must not speculate or answer from general knowledge — only from approved documents
- **Language:** Policy documents are all in English; the bot detects the language the employee writes in and responds in that language

### 2.2 HR Document Management via DM
- HR manages policy documents by **DMing the bot directly** using natural language — no dedicated upload channel
- Supported actions (all require a confirmation step before executing):
  - **Add a document:** HR uploads a PDF or DOCX file in the DM and says something like "add this as the benefits policy"
  - **Update a document:** HR uploads a new file and says "this replaces the current PTO policy" — old version is discarded, new version is indexed
  - **Delete a document:** HR says "remove the benefits policy" — bot confirms before deleting
- Bot always double-confirms destructive or modifying actions before proceeding (e.g., "Got it — I'll replace *Benefits-Policy-2025.pdf* with the new version. Confirm? ✅ / ❌")
- Multiple concurrent policy documents are supported
- On successful ingestion, bot confirms: "✅ *Benefits-Policy-2026.pdf* is now active."
- All document actions are logged for audit purposes

### 2.3 Guided Flows
Structured multi-step conversations for common high-volume topics:
- **Benefits enrollment** — walk employee through options and link to forms
- **Payroll questions** — answer FAQs, link to payroll contact or portal
- **Onboarding** — checklist and resource links for new hires
- **Offboarding** — checklist and routing to relevant contacts

Each flow is driven by document content, not hardcoded logic.

### 2.4 Conversation UX
- **Channel:** App DMs only (MVP) — both for employee Q&A and HR document management
- **Threading:** Bot replies in the user's thread as a sub-thread; does not start new top-level messages
- **Status emoji:** Bot reacts with ⏳ (hourglass) while generating a response, then replaces it with ✅ when done
- **Clarifying questions:** At most 1 per exchange — ask only when truly ambiguous
- **Context window:** Remembers the last 10 messages in a thread; if the thread is longer, informs the user and suggests starting a new thread
- **Action buttons:** Where applicable, include Slack interactive buttons (e.g., "View Policy", "Contact HR", "Start a New Thread")

### 2.5 Unanswered Questions Weekly Digest
- Every question the bot cannot answer (no document match) is logged
- Once per week, the bot posts a digest to `#policy-pony-slack-chatbot`
- This allows HR to identify documentation gaps and upload missing docs
- Format: grouped list with question text and timestamp

### 2.6 Compliance & Safety
- **AI disclosure:** Every bot response includes a brief footer: *"I'm an AI assistant. For sensitive matters, please contact HR directly."*
- **Source linking:** Every factual answer cites the source document by name
- **Sensitive topics:** For questions involving medical situations, legal matters, or personal data — route generically to HR and do not attempt to answer
- **No confidential data exposure:** The bot never reveals salary ranges for individuals, disciplinary records, or personal addresses
- **Audit logging:** All interactions are logged (question, answer, document cited, timestamp, Slack user ID)
- **Bias/fairness:** Routing and guidance must not differ based on employee identity attributes

---

## 3. Out of Scope (MVP)

| Feature | Notes |
|---|---|
| Support ticket creation (VPN, laptop, etc.) | Post-MVP |
| Zoho org chart integration | Post-MVP — do not build until explicitly requested |
| Slack channel support (public/private channels) | Post-MVP |
| Jobs & referrals / ATS integration | Post-MVP |
| Role-based access control | Post-MVP |
| Changing records in any HR system | Never |
| Employment decisions (performance, promotions, pay) | Never |
| Legal advice | Never |
| Individual medical advice | Never |

---

## 4. Technical Architecture

### 4.1 Component Overview

```
┌──────────────────────────────────────────────────────┐
│                    Slack Workspace                    │
│                                                       │
│  Employee DMs              HR Admin DMs               │
│  (ask questions)           (manage documents)         │
└────────────┬───────────────────────┬─────────────────┘
             │                       │
             ▼                       ▼
┌────────────────────────────────────────────────────────┐
│                Slack Bot (Bolt SDK)                    │
│  - Listens for DM messages (employees + HR)            │
│  - Detects file uploads in HR DMs                      │
│  - Manages emoji reactions & thread replies            │
│  - Routes: employee Q&A vs. HR document management     │
└──────────┬────────────────────────────────────────────┘
           │
           ├──────────────────────────────────────────────┐
           ▼                                              ▼
┌──────────────────────────┐             ┌───────────────────────────┐
│  Document Ingestion      │             │  Conversation Engine      │
│  Pipeline (HR DMs)       │             │  (RAG + Claude API)       │
│                          │             │                           │
│  - Confirm action w/ HR  │             │  - Embed query            │
│  - Download from Slack   │             │  - Search Supabase        │
│  - Parse PDF/DOCX        │             │    vector store           │
│  - Chunk & embed text    │             │  - Build prompt with      │
│  - Upsert to Supabase    │             │    context + history      │
│  - Handle versioning     │             │  - Call Claude API        │
└──────────┬───────────────┘             │  - Detect user language   │
           │                             │  - Respond in same lang   │
           ▼                             └───────────────────────────┘
┌──────────────────────────┐
│  Supabase (pgvector)     │
│                          │
│  - Document embeddings   │
│  - Document metadata     │
│    (name, version, date) │
│  - Unanswered Q log      │
│  - Audit log             │
└──────────────────────────┘
```

### 4.2 Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Slack integration | Slack Bolt SDK (Python) | Official Slack framework |
| LLM | Claude API — `claude-sonnet-4-6` | Main reasoning model |
| Embeddings | Anthropic embeddings or `text-embedding-3-small` | For vector search |
| Vector store | **Supabase (pgvector)** | Single DB for vectors + logs + metadata |
| Document parsing | `pdfplumber` (PDF) + `python-docx` (DOCX) | Python-based |
| Language detection | `langdetect` or Claude itself | Detect employee's language, respond in kind |
| Hosting | **Local dev (MVP)** → Vercel (post-MVP) | No deployment infra needed for MVP phase |
| Data residency | No constraints for MVP | — |

### 4.3 Document Versioning & Management

HR manages documents via natural language DMs with the bot. The bot:

1. Detects intent (add / update / remove a document)
2. **Always asks for confirmation before executing** any document change
3. On confirmed add/update: downloads the file, parses, chunks, embeds, upserts to Supabase
4. On confirmed update: deletes all chunks for the old document version first, then ingests new
5. On confirmed delete: removes all chunks for that document from Supabase
6. Confirms the result to HR: "✅ Done" or "❌ Error — please try again"
7. All actions are logged to the audit table in Supabase

**Versioning key:** document name as provided by HR in natural language (e.g., "benefits policy"). The bot maps this to the stored document name.

### 4.4 RAG Query Flow (Employee)

1. Employee sends DM to the bot
2. Bot reacts with ⏳
3. Bot detects employee's language
4. Bot retrieves the last 10 messages of the thread for context
5. Query is embedded → top-K relevant chunks retrieved from Supabase
6. Prompt assembled: `[system instructions] + [retrieved chunks with citations] + [conversation history] + [user question]`
7. Claude generates a grounded answer in the employee's language
8. If no relevant chunks found → log the question to Supabase, respond: "I don't know, please contact HR"
9. Bot removes ⏳, replies in thread with ✅ and the answer
10. Slack action buttons appended where applicable (e.g., "Contact HR")

### 4.5 Supabase Schema (Simplified)

```sql
-- Policy document chunks (vector store)
documents (id, doc_name, chunk_text, embedding vector, source_url, created_at)

-- Unanswered questions log
unanswered_questions (id, user_id, question_text, thread_ts, asked_at, digest_sent_at)

-- Audit log
audit_log (id, user_id, user_type, action, doc_name, question, answer, cited_doc, timestamp)
```

---

## 5. Implementation Phases

### Phase 1 — Foundation (Weeks 1–2)
- [ ] Set up Slack app (Bot Token, Event Subscriptions, Socket Mode)
- [ ] Set up Supabase project with pgvector extension and schema
- [ ] Build document ingestion pipeline: HR DM file upload → confirm → parse → chunk → embed → store
- [ ] Basic employee DM handler: receive message → RAG query → reply in thread
- [ ] Implement emoji status (⏳ / ✅)
- [ ] Implement "I don't know, please contact HR" fallback

### Phase 2 — Quality & UX (Weeks 3–4)
- [ ] Thread context window (last 10 messages)
- [ ] Document versioning (natural-language update + confirmation flow)
- [ ] Document deletion (natural-language + confirmation flow)
- [ ] Language detection — respond in user's language
- [ ] Slack interactive buttons (Contact HR, Start a New Thread)
- [ ] Citation formatting in responses (source document name)

### Phase 3 — Compliance & Ops (Weeks 5–6)
- [ ] Audit logging (all interactions to Supabase)
- [ ] Unanswered questions logger + weekly digest to `#policy-pony-slack-chatbot`
- [ ] Sensitive topic detection & generic HR routing
- [ ] AI disclosure footer on all employee responses
- [ ] HR confirmation flow polish (clear confirm/cancel buttons)

### Phase 4 — Testing & Launch (Weeks 7–8)
- [ ] Accuracy testing against known HR FAQ questions
- [ ] HR team UAT: document add/update/delete flows
- [ ] HR team UAT: guided flows (benefits, payroll, onboarding, offboarding)
- [ ] Edge-case testing: long threads, large PDFs, overlapping topics, non-English queries
- [ ] Internal pilot with a small employee group
- [ ] Full rollout + monitor containment rate

---

## 6. Post-MVP Roadmap

| Item | Description |
|---|---|
| Deploy to Vercel | Move from local dev to Vercel hosting |
| Slack channel support | Allow the bot to answer in public/private HR channels |
| Zoho org chart integration | "Who owns X?" routing — **do not build until explicitly requested** |
| Support ticket creation | VPN access, benefits, laptop support flows |
| Jobs & referrals | ATS search + referral policy answers (Hurma integration) |
| Role-based access | Filter answers based on employee role/department |
| Proactive notifications | Notify employees when a policy document is updated |

---

## 7. Resolved Decisions

| # | Question | Decision |
|---|---|---|
| 1 | HR upload mechanism | HR DMs the bot directly using natural language (no dedicated channel) |
| 2 | Digest channel | `#policy-pony-slack-chatbot` |
| 3 | Escalation target | Generic "please contact HR" — no specific person or channel for MVP |
| 4 | Document deletion UX | Natural language DM with mandatory confirmation step |
| 5 | Hosting | Local dev for MVP; Vercel post-MVP |
| 6 | Vector database | Supabase (pgvector) |
| 7 | Data residency | No constraints for MVP |
| 8 | Language support | Docs are English; bot responds in the language the employee writes in |

---

*Document prepared by Claude Code (Anthropic) as a BA requirements artifact, March 3, 2026.*
