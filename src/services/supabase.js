const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: -1 } },  // disable realtime background connection
  }
);

// ── Policy documents ───────────────────────────────────────────────────────

async function upsertDocument({ docName, originalFilename, slackFileId, uploadedBy }) {
  const { data, error } = await supabase
    .from('policy_documents')
    .upsert(
      {
        doc_name: docName,
        original_filename: originalFilename,
        slack_file_id: slackFileId,
        uploaded_by: uploadedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'doc_name' }
    )
    .select()
    .single();

  if (error) throw new Error(`upsertDocument: ${error.message}`);
  return data;
}

async function deleteDocumentByName(docName) {
  const { error } = await supabase
    .from('policy_documents')
    .delete()
    .eq('doc_name', docName);
  if (error) throw new Error(`deleteDocument: ${error.message}`);
}

async function listAllDocuments() {
  const { data, error } = await supabase
    .from('policy_documents')
    .select('doc_name, original_filename, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`listDocuments: ${error.message}`);
  return data || [];
}

// ── Chunks ─────────────────────────────────────────────────────────────────

async function insertChunks(chunks) {
  const { error } = await supabase.from('document_chunks').insert(chunks);
  if (error) throw new Error(`insertChunks: ${error.message}`);
}

async function deleteChunksByDocName(docName) {
  const { error } = await supabase
    .from('document_chunks')
    .delete()
    .eq('doc_name', docName);
  if (error) throw new Error(`deleteChunks: ${error.message}`);
}

// ── Vector search ──────────────────────────────────────────────────────────

async function searchSimilarChunks(embedding, matchCount = 5, matchThreshold = 0.5) {
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: embedding,
    match_threshold: matchThreshold,
    match_count: matchCount,
  });
  if (error) throw new Error(`searchChunks: ${error.message}`);
  return data || [];
}

// ── Logging ────────────────────────────────────────────────────────────────

async function logUnansweredQuestion({ userId, questionText, threadTs, channel }) {
  const { error } = await supabase.from('unanswered_questions').insert({
    user_id: userId,
    question_text: questionText,
    thread_ts: threadTs,
    channel,
  });
  if (error) console.error('Failed to log unanswered question:', error.message);
}

async function logAudit({ userId, userType, action, docName, question, answer, citedDoc }) {
  const { error } = await supabase.from('audit_log').insert({
    user_id: userId,
    user_type: userType,
    action,
    doc_name: docName || null,
    question: question || null,
    answer: answer || null,
    cited_doc: citedDoc || null,
  });
  if (error) console.error('Failed to log audit:', error.message);
}

module.exports = {
  upsertDocument,
  deleteDocumentByName,
  listAllDocuments,
  insertChunks,
  deleteChunksByDocName,
  searchSimilarChunks,
  logUnansweredQuestion,
  logAudit,
};
