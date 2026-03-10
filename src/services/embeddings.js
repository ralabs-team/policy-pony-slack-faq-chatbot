const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Embed a single text string. Returns a number[].
 */
async function embedText(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n/g, ' '),
  });
  return response.data[0].embedding;
}

/**
 * Embed multiple texts in a single API call. Returns number[][].
 */
async function embedBatch(texts) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map((t) => t.replace(/\n/g, ' ')),
  });
  return response.data.map((d) => d.embedding);
}

module.exports = { embedText, embedBatch };
