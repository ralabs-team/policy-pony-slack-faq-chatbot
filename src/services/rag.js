const { embedText } = require('./embeddings');
const { searchSimilarChunks } = require('./supabase');
const { generateAnswer } = require('./claude');
const log = require('../utils/logger');

const MATCH_THRESHOLD = 0.2;
const MATCH_COUNT = 5;

/**
 * Run the full RAG pipeline for an employee question.
 *
 * @param {string} question - The user's question
 * @param {Array<{role: string, content: string}>} conversationHistory - Last N messages
 * @returns {{ answer: string, citedDoc: string|null } | null} null if no relevant content found
 */
async function query(question, conversationHistory = []) {
  log.info('RAG', `🔎 Embedding query...`);
  const embedding = await embedText(question);

  log.info('RAG', `📚 Searching vector DB (threshold: ${MATCH_THRESHOLD}, top: ${MATCH_COUNT})`);
  const chunks = await searchSimilarChunks(embedding, MATCH_COUNT, MATCH_THRESHOLD);

  if (!chunks || chunks.length === 0) {
    log.warn('RAG', `No relevant chunks found`);
    return null;
  }

  const topSimilarity = chunks[0]?.similarity?.toFixed(3) ?? 'n/a';
  const sources = [...new Set(chunks.map((c) => c.doc_name))].join(', ');
  log.info('RAG', `📖 Found ${chunks.length} chunk(s) — top similarity: ${topSimilarity} — sources: ${sources}`);
  log.info('RAG', `🤖 Generating answer with Claude...`);

  return generateAnswer(question, chunks, conversationHistory);
}

module.exports = { query };
