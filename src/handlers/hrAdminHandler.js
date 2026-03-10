const { randomUUID } = require('crypto');
const { ingestDocument, deleteDocument, listDocuments } = require('../services/ingestion');
const { detectHrIntent } = require('../services/claude');
const { downloadSlackFile } = require('../utils/slackFile');
const { handleEmployeeDm } = require('./employeeHandler');
const log = require('../utils/logger');

const HR_USER_IDS = (process.env.HR_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

function isHrAdmin(userId) {
  return HR_USER_IDS.includes(userId);
}

// In-memory store for pending HR confirmations (keyed by action UUID)
// Each entry is auto-expired after 10 minutes
const pendingActions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, action] of pendingActions.entries()) {
    if (now - action.createdAt > 10 * 60 * 1000) pendingActions.delete(key);
  }
}, 60 * 1000);

async function handleHrAdminDm({ message, client }) {
  const { channel, ts, text, files, user } = message;
  const hasFile = Array.isArray(files) && files.length > 0;
  const messageText = text || '';

  const intent = await detectHrIntent(messageText, hasFile);
  log.info('HR', `👤 ${log.who(user)} → intent: ${intent.action}${intent.docName ? ` | doc: "${intent.docName}"` : ''}${hasFile ? ` | file: ${files[0].name} (${(files[0].size / 1024).toFixed(0)} KB)` : ''}`);

  if (intent.action === 'list') {
    log.info('HR', `📋 ${log.who(user)} requested document list`);
    return handleListDocuments(client, channel, ts);
  }

  if (intent.action === 'add' || intent.action === 'update') {
    if (!hasFile) {
      log.warn('HR', `${log.who(user)} tried to ${intent.action} without attaching a file`);
      return client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: 'Please upload a PDF or DOCX file to add or update a policy document.',
      });
    }
    return handleAddOrUpdate(client, channel, ts, files[0], intent, user);
  }

  if (intent.action === 'delete') {
    return handleDeleteConfirm(client, channel, ts, intent.docName, user);
  }

  // Unknown intent — treat HR admin as a regular employee so they can ask questions too
  log.info('HR', `${user} sent unknown HR intent — routing to employee Q&A`);
  return handleEmployeeDm({ message, client });
}

// ── Confirmation builders ──────────────────────────────────────────────────

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

async function handleAddOrUpdate(client, channel, ts, file, intent, userId) {
  if (file.size > MAX_FILE_BYTES) {
    log.warn('HR', `File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) — rejected`);
    return client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `❌ File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Please upload a file under 25 MB.`,
    });
  }

  const docName = intent.docName || file.name;
  const actionId = randomUUID();

  log.info('HR', `⏳ Awaiting confirmation: ${intent.action} "${docName}" from ${file.name} [action: ${actionId.slice(0, 8)}...]`);

  pendingActions.set(actionId, {
    type: intent.action,
    docName,
    file,
    userId,
    createdAt: Date.now(),
  });

  const verb = intent.action === 'update' ? 'replace the current' : 'add';
  const detail =
    intent.action === 'update'
      ? `I'll *replace* the current *${docName}* policy with *${file.name}*. The old version will be permanently removed.`
      : `I'll add *${file.name}* as the *${docName}* policy.`;

  await client.chat.postMessage({
    channel,
    thread_ts: ts,
    blocks: confirmationBlocks(detail, actionId),
    text: detail,
  });
}

async function handleDeleteConfirm(client, channel, ts, docName, userId) {
  if (!docName) {
    log.info('HR', `${log.who(userId)} requested delete list — showing docs with delete buttons`);
    return handleListDocuments(client, channel, ts, true);
  }

  const actionId = randomUUID();
  log.info('HR', `⏳ Awaiting confirmation: delete "${docName}" [action: ${actionId.slice(0, 8)}...]`);
  pendingActions.set(actionId, {
    type: 'delete',
    docName,
    userId,
    createdAt: Date.now(),
  });

  const detail = `Are you sure you want to *permanently remove* the *${docName}* policy? Employees will no longer get answers from this document.`;
  await client.chat.postMessage({
    channel,
    thread_ts: ts,
    blocks: confirmationBlocks(detail, actionId),
    text: detail,
  });
}

async function handleListDocuments(client, channel, ts, withDeleteButtons = false) {
  const docs = await listDocuments();
  if (!docs || docs.length === 0) {
    return client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: 'No policy documents have been uploaded yet.',
    });
  }

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Current policy documents (${docs.length}):*` },
    },
    { type: 'divider' },
    ...docs.map((d) => {
      const block = {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${d.doc_name}*\n_${d.original_filename}_ — updated ${new Date(d.updated_at).toLocaleDateString()}`,
        },
      };
      if (withDeleteButtons) {
        block.accessory = {
          type: 'button',
          text: { type: 'plain_text', text: '🗑️ Delete' },
          style: 'danger',
          action_id: 'delete_doc_request',
          value: d.doc_name,
        };
      }
      return block;
    }),
  ];

  return client.chat.postMessage({
    channel,
    thread_ts: ts,
    blocks,
    text: `Current policy documents (${docs.length})`,
  });
}

// ── Block action handler (confirm / cancel buttons) ────────────────────────

async function handleBlockAction({ ack, body, client, action }) {
  await ack();

  const actionUuid = action.value;
  const pending = pendingActions.get(actionUuid);
  const channel = body.channel?.id;

  if (!pending || !channel) return;

  const isConfirm = action.action_id.startsWith('confirm_action_');

  // Replace the button message immediately so HR can't double-click
  await client.chat
    .update({
      channel,
      ts: body.message.ts,
      blocks: [],
      text: isConfirm ? '⏳ Processing...' : '❌ Action cancelled.',
    })
    .catch(() => {});

  if (!isConfirm) {
    log.info('HR', `❌ Action cancelled by ${log.who(body.user?.id)}: ${pending.type} "${pending.docName}"`);
    pendingActions.delete(actionUuid);
    return;
  }

  log.info('HR', `✅ Action confirmed by ${log.who(body.user?.id)}: ${pending.type} "${pending.docName}"`);
  pendingActions.delete(actionUuid);

  try {
    if (pending.type === 'add' || pending.type === 'update') {
      log.info('HR', `⬇️  Downloading file from Slack: ${pending.file.name}`);
      const fileBuffer = await downloadSlackFile(pending.file.url_private);
      log.info('HR', `📄 File downloaded (${(fileBuffer.length / 1024).toFixed(0)} KB) — starting ingestion`);

      await ingestDocument({
        docName: pending.docName,
        originalFilename: pending.file.name,
        fileBuffer,
        mimetype: pending.file.mimetype,
        slackFileId: pending.file.id,
        uploadedBy: pending.userId,
      });

      const verb = pending.type === 'update' ? 'updated' : 'added';
      log.info('HR', `🎉 Doc "${pending.docName}" successfully ${verb}`);
      await client.chat.update({
        channel,
        ts: body.message.ts,
        text: `✅ *${pending.file.name}* has been ${verb} as the *${pending.docName}* policy and is now active.`,
      });
    } else if (pending.type === 'delete') {
      await deleteDocument(pending.docName);
      log.info('HR', `🗑️  Doc "${pending.docName}" deleted`);
      await client.chat.update({
        channel,
        ts: body.message.ts,
        text: `✅ The *${pending.docName}* policy has been removed.`,
      });
    }
  } catch (err) {
    log.error('HR', `Failed to execute ${pending.type} for "${pending.docName}"`, err);
    await client.chat
      .update({
        channel,
        ts: body.message.ts,
        text: `❌ Something went wrong: ${err.message}\nPlease try again.`,
      })
      .catch(() => {});
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function confirmationBlocks(text, actionId) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: text + '\n\nShall I proceed?' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Confirm' },
          style: 'primary',
          action_id: `confirm_action_${actionId}`,
          value: actionId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Cancel' },
          style: 'danger',
          action_id: `cancel_action_${actionId}`,
          value: actionId,
        },
      ],
    },
  ];
}

// ── Delete button handler (from document list) ─────────────────────────────

async function handleDeleteDocRequest({ ack, body, client, action }) {
  await ack();

  const userId = body.user?.id;
  const channel = body.channel?.id;
  const docName = action.value;

  if (!isHrAdmin(userId)) {
    log.warn('HR', `⛔ Non-HR user ${log.who(userId)} tried to delete doc "${docName}" — blocked`);
    return;
  }

  log.info('HR', `🗑️  ${log.who(userId)} clicked delete for "${docName}"`);
  await handleDeleteConfirm(client, channel, body.message.ts, docName, userId);
}

module.exports = { handleHrAdminDm, handleBlockAction, handleDeleteDocRequest };
