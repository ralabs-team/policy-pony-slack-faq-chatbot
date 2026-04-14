const { randomUUID } = require('crypto');
const { logAudit, getLastBroadcastTime } = require('../services/supabase');
const analytics = require('../services/analytics');
const log = require('../utils/logger');

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// In-memory store for pending notifications, auto-expire after 10 min
const pendingNotifications = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, n] of pendingNotifications.entries()) {
    if (now - n.createdAt > 10 * 60 * 1000) pendingNotifications.delete(key);
  }
}, 60 * 1000);

async function handleNotifyRequest(client, channel, ts, messageText, userId) {
  // Cooldown check
  const lastBroadcast = await getLastBroadcastTime();
  if (lastBroadcast) {
    const elapsed = Date.now() - new Date(lastBroadcast).getTime();
    if (elapsed < COOLDOWN_MS) {
      const sentAt = new Date(lastBroadcast).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const minutesLeft = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
      return client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: `⛔ A broadcast was sent less than an hour ago (at ${sentAt}). Please wait ${minutesLeft} more minute(s) before sending another.`,
        unfurl_links: false,
      });
    }
  }

  // Fetch member count for preview
  const result = await client.users.list({ limit: 1000 });
  const members = (result.members || []).filter((u) => !u.is_bot && !u.deleted && u.id !== 'USLACKBOT');
  const count = members.length;

  const actionId = randomUUID();
  pendingNotifications.set(actionId, { messageText, userId, createdAt: Date.now() });

  await client.chat.postMessage({
    channel,
    thread_ts: ts,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `You're about to DM *${count} people*:\n\n> ${messageText}\n\nShall I proceed?`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Send to everyone' },
            style: 'primary',
            action_id: `confirm_notify_${actionId}`,
            value: actionId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Cancel' },
            style: 'danger',
            action_id: `cancel_notify_${actionId}`,
            value: actionId,
          },
        ],
      },
    ],
    text: `About to DM ${count} people: "${messageText}"`,
    unfurl_links: false,
  });
}

async function handleNotifyAction({ ack, body, client, action }) {
  await ack();

  const actionId = action.value;
  const pending = pendingNotifications.get(actionId);
  const userId = body.user.id;
  const channel = body.channel?.id;
  const messageTs = body.message?.ts;

  if (!pending) {
    await client.chat.update({ channel, ts: messageTs, blocks: [], text: '⚠️ This notification expired. Please send `notify everyone:` again.' });
    return;
  }

  const isConfirm = action.action_id.startsWith('confirm_notify_');
  pendingNotifications.delete(actionId);

  if (!isConfirm) {
    log.info('NOTIFY', `❌ Broadcast cancelled by ${log.who(userId)}`);
    await client.chat.update({ channel, ts: messageTs, blocks: [], text: '❌ Notification cancelled.' });
    return;
  }

  await client.chat.update({ channel, ts: messageTs, blocks: [], text: '⏳ Sending messages...' });

  const result = await client.users.list({ limit: 1000 });
  const members = (result.members || []).filter((u) => !u.is_bot && !u.deleted && u.id !== 'USLACKBOT');

  log.info('NOTIFY', `📢 Broadcast started by ${log.who(userId)} — ${members.length} recipients`);

  let sent = 0;
  let failed = 0;

  for (const member of members) {
    try {
      const dm = await client.conversations.open({ users: member.id });
      await client.chat.postMessage({
        channel: dm.channel.id,
        text: pending.messageText,
        unfurl_links: false,
      });
      sent++;
    } catch (err) {
      log.warn('NOTIFY', `Failed to DM ${member.id}: ${err.message}`);
      failed++;
    }
  }

  log.info('NOTIFY', `✅ Broadcast complete — ${sent} sent, ${failed} failed`);
  analytics.track(userId, 'Broadcast Sent', { sent, failed, message: pending.messageText });

  await logAudit({ userId, userType: 'hr_admin', action: 'broadcast', question: pending.messageText, answer: null, citedDoc: null });

  await client.chat.update({
    channel,
    ts: messageTs,
    blocks: [],
    text: `✅ Message sent to *${sent}* people.${failed > 0 ? ` ${failed} failed — check Vercel logs.` : ''}`,
  });
}

module.exports = { handleNotifyRequest, handleNotifyAction };
