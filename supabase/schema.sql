-- Run this in your Supabase SQL Editor to set up the database schema.
-- Dashboard: https://supabase.com -> your project -> SQL Editor

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Policy documents (metadata)
CREATE TABLE IF NOT EXISTS policy_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_name TEXT NOT NULL UNIQUE,          -- human-readable name, used as version key
  original_filename TEXT NOT NULL,
  slack_file_id TEXT,
  uploaded_by TEXT NOT NULL,              -- Slack user ID of uploader
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Document chunks with embeddings (text-embedding-3-small = 1536 dims)
CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_name TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Index for fast vector similarity search
-- NOTE: IVFFlat requires at least `lists` rows to work. Skip for MVP (sequential scan is fine at small scale).
-- Uncomment and run manually once you have 1000+ chunks:
-- CREATE INDEX document_chunks_embedding_idx
--   ON document_chunks USING ivfflat (embedding vector_cosine_ops)
--   WITH (lists = 100);

-- 5. Unanswered questions log (feeds the weekly digest)
CREATE TABLE IF NOT EXISTS unanswered_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  question_text TEXT NOT NULL,
  thread_ts TEXT,
  channel TEXT,
  asked_at TIMESTAMPTZ DEFAULT NOW(),
  digest_sent_at TIMESTAMPTZ            -- set when included in a weekly digest
);

-- 6. Audit log (all interactions)
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  user_type TEXT NOT NULL,              -- 'employee' | 'hr_admin'
  action TEXT NOT NULL,                 -- 'query' | 'doc_add' | 'doc_update' | 'doc_delete'
  doc_name TEXT,
  question TEXT,
  answer TEXT,
  cited_doc TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- 7. User preferences (employment type etc., cached for 30 days)
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, key)
);

-- 8. Disable RLS on all bot tables (server-side bot uses service role — RLS not needed)
ALTER TABLE policy_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks DISABLE ROW LEVEL SECURITY;
ALTER TABLE unanswered_questions DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;

-- 8. Similarity search function used by the RAG pipeline
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding VECTOR(1536),
  match_threshold FLOAT,
  match_count INT
)
RETURNS TABLE (
  id UUID,
  doc_name TEXT,
  chunk_text TEXT,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    document_chunks.id,
    document_chunks.doc_name,
    document_chunks.chunk_text,
    1 - (document_chunks.embedding <=> query_embedding) AS similarity
  FROM document_chunks
  WHERE 1 - (document_chunks.embedding <=> query_embedding) > match_threshold
  ORDER BY document_chunks.embedding <=> query_embedding
  LIMIT match_count;
$$;
