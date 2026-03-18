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
Today's date is ${today}. When answering questions about "next", "upcoming", or "closest" dates, only consider dates that are STRICTLY AFTER today (${today}). Never suggest a date that has already passed.

⚠️ LANGUAGE RULE — ABSOLUTE PRIORITY: You MUST respond in the same language as the employee's question — NOT in the language of the source documents. If the question is in English, respond in English. If in Ukrainian, respond in Ukrainian. Never let the document language influence your response language.

STRICT RULES:
1. Answer ONLY from the provided policy context. Never use general knowledge or make things up.
   Do NOT greet the user or use openers like "Hi", "Hello", "Sure!" — go straight to the answer.
2. If NONE of the questions can be answered from the context, respond with exactly the word: ${NOT_FOUND_SIGNAL}
   If the user asks multiple questions and only SOME can be answered: answer what you know, and for the ones you don't have info on write "Unfortunately, I couldn't find anything about [topic] in our policies." — replacing [topic] with the specific subject of that question (never write "${NOT_FOUND_SIGNAL}" inline — only use it when the entire response is not found).
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
7. End every answer with a closing question in the same language as your response:
   - English: "Is there anything else I can help you with?"
   - Ukrainian: "З чим іще я можу допомогти?"
8. When responding in Ukrainian, always use the untranslated English term "full-time" — write "full-time працівники" (NEVER "повні працівники", NEVER "повні співробітники"). Use "контрактори" (not "підрядники").

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

  // Safety net: replace any literal NOT_FOUND signal that leaked into a mixed response
  const cleanedText = text.replace(/NOT_FOUND\.?/g, "Unfortunately, I couldn't find anything about that in our policies.");

  // Flag partial not-found responses so the handler can show the request buttons
  const isPartialNotFound = cleanedText.includes("Unfortunately, I couldn't find anything about");

  const citedDoc = chunks[0]?.doc_name || null;
  return { answer: cleanedText, citedDoc, isSensitive: false, isPartialNotFound };
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

/**
 * Generate a capability overview based on currently uploaded document names.
 * Responds in the same language as the question (EN or UA).
 */
/**
 * @param {Object} chunksPerDoc - { docName: [chunk1, chunk2, ...] }
 * @param {boolean} isUkrainian
 */
async function generateCapabilityResponse(chunksPerDoc, isUkrainian) {
  const language = isUkrainian ? 'Ukrainian' : 'English';
  const closing = isUkrainian ? 'З чим іще я можу допомогти?' : 'Is there anything else I can help you with?';

  const context = Object.entries(chunksPerDoc)
    .map(([name, chunks]) => `[${name}]\n${chunks.join('\n')}`)
    .join('\n\n---\n\n');

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: `You are Policy Pony, a friendly and informal HR assistant bot for Ralabs.
Based ONLY on the actual document content provided below, list what topics you can help with and give 2-3 example questions per document that you can genuinely answer.
Only include questions that are clearly covered by the document content — do not invent topics or questions that aren't there.
Use Slack markdown: *bold* for document/topic names, bullet points ( • ) for example questions.
Be warm and conversational — not corporate.
Respond in ${language}.
End your response with exactly: "${closing}"`,
        },
        {
          role: 'user',
          content: context,
        },
      ],
    });
    return response.choices[0].message.content.trim();
  } catch {
    const docNames = Object.keys(chunksPerDoc);
    return isUkrainian
      ? `Я можу допомогти з питаннями про: ${docNames.join(', ')}. ${closing}`
      : `I can help with questions about: ${docNames.join(', ')}. ${closing}`;
  }
}

module.exports = { generateAnswer, NOT_FOUND_MESSAGE, detectHrIntent, generateCapabilityResponse };
