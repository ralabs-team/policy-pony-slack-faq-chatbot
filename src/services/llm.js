const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SENSITIVE_TOPICS_SIGNAL = 'SENSITIVE_TOPIC';
const NOT_FOUND_SIGNAL = 'NOT_FOUND';

/**
 * Generate a grounded answer from retrieved policy chunks.
 * Returns { answer, citedDoc } or null if the answer is not found.
 */
async function generateAnswer(question, chunks, conversationHistory = []) {
  const contextBlocks = chunks
    .map((c) => `[Source: ${c.doc_name}]\n${c.chunk_text}`)
    .join('\n\n---\n\n');

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const systemPrompt = `You are Policy Pony, a friendly and informal HR assistant — like a knowledgeable colleague, not a corporate handbook.
Your sole job is to answer HR-related questions based ONLY on the documents provided below.
Today's date is ${today}. Use this when answering time-relative questions (e.g. "next", "closest", "upcoming").

⚠️ LANGUAGE RULE — ABSOLUTE PRIORITY: You MUST respond in the same language as the employee's question — NOT in the language of the source documents. If the question is in English, respond in English. If in Ukrainian, respond in Ukrainian. Never let the document language influence your response language.

STRICT RULES:
1. Answer ONLY from the provided policy context. Never use general knowledge or make things up.
   Do NOT greet the user or use openers like "Hi", "Hello", "Sure!" — go straight to the answer.
2. If the answer is not in the context, respond with exactly the word: ${NOT_FOUND_SIGNAL}
3. Do NOT mention the source document name in your answer. Just provide the answer directly.
4. Be concise and friendly with an informal, conversational tone — avoid corporate or stiff language. Do not use emojis in your response.
   Keep your response to a maximum of 50 words. If the full answer is longer, summarize the key points only. If the source document includes instructions on where to find more information (e.g. a portal link, a system to log into, steps to follow), include those at the end as a "where to find more" note — only if explicitly stated in the document.
   Format your response using Slack markdown:
   - Use *bold* (single asterisks) for key terms, dates, and important values — NOT **double asterisks**
   - Use bullet points ( • ) for lists
   - Use line breaks between sections for readability
   - Do NOT copy the formatting or structure of the source document — adapt it to be clean and readable in Slack
5. NEVER provide legal advice, medical advice, or reveal confidential personal data (individual salaries, disciplinary actions, etc.).
6. If the question involves medical situations, legal matters, or confidential personal data, respond with exactly: ${SENSITIVE_TOPICS_SIGNAL}
7. End every answer with "Is there anything else I can help you with?"

POLICY CONTEXT:
${contextBlocks}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-10),
    { role: 'user', content: question },
  ];

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1024,
    messages,
  });

  const text = response.choices[0].message.content.trim();

  if (text.startsWith(NOT_FOUND_SIGNAL)) return null;

  if (text === SENSITIVE_TOPICS_SIGNAL) {
    return {
      answer:
        "This topic involves sensitive or confidential matters that I'm not able to address. Please contact HR directly for assistance.",
      citedDoc: null,
      isSensitive: true,
    };
  }

  const citedDoc = chunks[0]?.doc_name || null;
  return { answer: text, citedDoc, isSensitive: false };
}

/**
 * Detect what an HR admin wants to do based on their message.
 * Returns { action: 'add'|'update'|'delete'|'list'|'unknown', docName: string|null }
 */
async function detectHrIntent(text, hasFile) {
  const lower = (text || '').toLowerCase();

  const listKeywords = ['document', 'polic', 'file', 'upload', 'all'];
  if (
    (lower.includes('list') && listKeywords.some((k) => lower.includes(k))) ||
    lower.includes('show all') ||
    lower.includes('what policies') ||
    lower.includes('what documents') ||
    lower.includes('show documents') ||
    lower.includes('show policies')
  ) {
    return { action: 'list', docName: null };
  }

  if (!hasFile && (lower.includes('remov') || lower.includes('delet') || lower.includes('retir'))) {
    const docName = await extractDocName(text);
    return { action: 'delete', docName };
  }

  if (hasFile) {
    const isUpdate =
      lower.includes('replac') ||
      lower.includes('updat') ||
      lower.includes('new version') ||
      lower.includes('supersed');
    const docName = await extractDocName(text);
    return { action: isUpdate ? 'update' : 'add', docName };
  }

  return { action: 'unknown', docName: null };
}

/**
 * Use GPT-4o-mini to extract a human-readable document/policy name from an HR message.
 */
async function extractDocName(text) {
  if (!text || text.trim() === '') return null;
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 30,
      messages: [
        {
          role: 'system',
          content:
            'Extract the policy or document name from the HR message. Return ONLY the name (e.g. "Benefits Policy", "PTO Policy"). If no specific name is mentioned, return "unknown".',
        },
        { role: 'user', content: text },
      ],
    });
    const name = response.choices[0].message.content.trim();
    return name === 'unknown' ? null : name;
  } catch {
    return null;
  }
}

const NOT_FOUND_MESSAGE = "Hmm, I couldn't find anything on that. Is there anything else I can help you with?";

module.exports = { generateAnswer, NOT_FOUND_MESSAGE, detectHrIntent };
