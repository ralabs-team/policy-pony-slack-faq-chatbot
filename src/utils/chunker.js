/**
 * Split text into overlapping chunks, trying to break at natural boundaries
 * (paragraph → sentence → word) to keep semantic context intact.
 *
 * Default: ~1500 chars per chunk (~375 tokens), 200 char overlap.
 */
function chunkText(text, chunkSize = 1500, overlap = 200) {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (normalized.length <= chunkSize) return [normalized];

  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);

    if (end < normalized.length) {
      // Prefer paragraph break
      const paraBreak = normalized.lastIndexOf('\n\n', end);
      // Fall back to sentence break
      const sentBreak = normalized.lastIndexOf('. ', end);

      if (paraBreak > start + overlap) {
        end = paraBreak + 2;
      } else if (sentBreak > start + overlap) {
        end = sentBreak + 2;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);

    if (end >= normalized.length) break;

    start = end - overlap;
    if (start >= normalized.length) break;
  }

  return chunks;
}

module.exports = { chunkText };
