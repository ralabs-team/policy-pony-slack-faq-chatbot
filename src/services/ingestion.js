const { execFile } = require('child_process');
const { writeFile, unlink } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const { embedText } = require('./embeddings');
const {
  upsertDocument,
  deleteDocumentByName,
  deleteChunksByDocName,
  insertChunks,
  listAllDocuments,
} = require('./supabase');
const log = require('../utils/logger');

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
      const paraBreak = normalized.lastIndexOf('\n\n', end);
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

function memMB() {
  return `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * Ingest a document: parse → chunk → embed+store one chunk at a time.
 * Always replaces existing chunks for the same docName (idempotent versioning).
 */
async function ingestDocument({ docName, originalFilename, fileBuffer, mimetype, slackFileId, uploadedBy }) {
  log.info('INGEST', `📄 Parsing "${originalFilename}" (${mimetype}) [mem: ${memMB()}]`);
  const text = await parseDocument(fileBuffer, mimetype, originalFilename);

  if (!text || text.trim().length === 0) {
    throw new Error('Could not extract any text from the document. Check that the file is not empty or image-only.');
  }

  log.info('INGEST', `📝 Extracted ${text.length.toLocaleString()} characters of text [mem: ${memMB()}]`);

  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error('Document appears to be empty after processing.');
  log.info('INGEST', `✂️  Split into ${chunks.length} chunks [mem: ${memMB()}]`);

  // Delete existing chunks first (versioning: new upload always replaces old)
  log.info('INGEST', `🗑️  Clearing old chunks for "${docName}" [mem: ${memMB()}]`);
  await deleteChunksByDocName(docName);

  // Upsert document metadata first
  log.info('INGEST', `💾 Saving document metadata... [mem: ${memMB()}]`);
  await upsertDocument({ docName, originalFilename, slackFileId, uploadedBy });

  // Embed and insert one chunk at a time — never hold all embeddings in memory
  log.info('INGEST', `🧠 Embedding and saving ${chunks.length} chunk(s) one by one... [mem: ${memMB()}]`);
  for (let i = 0; i < chunks.length; i++) {
    if (i % 10 === 0) {
      log.info('INGEST', `   chunk ${i + 1}/${chunks.length} [mem: ${memMB()}]`);
    }
    const embedding = await embedText(chunks[i]);
    await insertChunks([{
      doc_name: docName,
      chunk_index: i,
      chunk_text: chunks[i],
      embedding: `[${embedding.join(',')}]`,
    }]);
  }

  log.info('INGEST', `✅ Done — "${docName}" is live (${chunks.length} chunks from ${originalFilename}) [mem: ${memMB()}]`);
}

/**
 * Remove a document and all its chunks.
 */
async function deleteDocument(docName) {
  log.info('INGEST', `🗑️  Deleting all chunks for "${docName}"`);
  await deleteChunksByDocName(docName);
  await deleteDocumentByName(docName);
  log.info('INGEST', `✅ Document "${docName}" fully removed`);
}

/**
 * List all uploaded documents.
 */
async function listDocuments() {
  return listAllDocuments();
}

// ── Parsers ────────────────────────────────────────────────────────────────

async function parseDocument(buffer, mimetype, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();

  if (mimetype === 'application/pdf' || ext === 'pdf') {
    return parsePdf(buffer);
  }

  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    // Lazy-load mammoth only when needed — avoids loading bluebird/jszip/lodash at startup
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimetype === 'text/plain' || ext === 'txt') {
    return buffer.toString('utf-8');
  }

  throw new Error(`Unsupported file type "${mimetype || ext}". Please upload a PDF, DOCX, or TXT file.`);
}

/**
 * Extract text from a PDF using pdftotext (poppler).
 * Runs in a child process — zero heap impact on the main Node process.
 * Images and graphics are automatically skipped.
 * Requires: brew install poppler
 */
async function parsePdf(buffer) {
  const tmpFile = join(tmpdir(), `policy-pony-${Date.now()}.pdf`);
  await writeFile(tmpFile, buffer);

  try {
    const text = await new Promise((resolve, reject) => {
      // '-' as output file means write to stdout
      const env = {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      };
      execFile('pdftotext', ['-enc', 'UTF-8', '-nopgbrk', tmpFile, '-'], { env }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(
            `pdftotext failed: ${err.message}\n` +
            `Make sure poppler is installed: brew install poppler`
          ));
        } else {
          resolve(stdout);
        }
      });
    });
    return text;
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

module.exports = { ingestDocument, deleteDocument, listDocuments };
