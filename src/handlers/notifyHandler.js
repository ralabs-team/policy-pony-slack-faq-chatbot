const { randomUUID } = require('crypto');
const { logAudit, getLastBroadcastTime } = require('../services/supabase');
const analytics = require('../services/analytics');
const log = require('../utils/logger');

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID;

async function getChannelMembers(client, channelId) {
  if (!channelId) throw new Error('GENERAL_CHANNEL_ID env variable is not set.');

  const memberIds = [];
  let cursor;
  do {
    const result = await client.conversations.members({
      channel: channelId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    memberIds.push(...(result.members || []));
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  // Fetch full user objects to filter bots/guests
  const usersResult = await client.users.list({ limit: 1000 });
  const userMap = {};
  for (const u of usersResult.members || []) userMap[u.id] = u;

  return memberIds
    .map((id) => userMap[id])
    .filter((u) => u && !u.is_bot && !u.deleted && !u.is_restricted && !u.is_ultra_restricted && u.id !== 'USLACKBOT');
}

// In-memory store for pending notifications, auto-expire after 10 min
const pendingNotifications = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, n] of pendingNotifications.entries()) {
    if (now - n.createdAt > 10 * 60 * 1000) pendingNotifications.delete(key);
  }
}, 60 * 1000);

async function handleNotifyRequest(client, channel, ts, messageText, userId, channelOverride = null) {
  // Cooldown warning (informational only — does not block)
  const lastBroadcast = await getLastBroadcastTime();
  if (lastBroadcast) {
    const elapsed = Date.now() - new Date(lastBroadcast).getTime();
    if (elapsed < COOLDOWN_MS) {
      const sentAt = new Date(lastBroadcast).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      await client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: `⚠️ Heads up — a broadcast was already sent today at ${sentAt}. You can still proceed.`,
        unfurl_links: false,
      });
    }
  }

  // Fetch member count for preview
  const targetChannel = channelOverride || GENERAL_CHANNEL_ID;
  const members = await getChannelMembers(client, targetChannel);
  const count = members.length;

  const actionId = randomUUID();
  pendingNotifications.set(actionId, { messageText, userId, channelOverride, createdAt: Date.now() });

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

  // Single-user DM
  if (pending.targetUserId) {
    try {
      const dm = await client.conversations.open({ users: pending.targetUserId });
      await client.chat.postMessage({ channel: dm.channel.id, text: pending.messageText, unfurl_links: false });
      const { name: targetName } = analytics.getUser(pending.targetUserId);
      log.info('NOTIFY', `📨 DM sent to ${log.who(pending.targetUserId)} by ${log.who(userId)}`);
      analytics.track(userId, 'Single DM Sent', { target: pending.targetUserId, message: pending.messageText });
    } catch (err) {
      await client.chat.update({ channel, ts: messageTs, blocks: [], text: `❌ Failed to send DM: ${err.message}` });
      return;
    }
    await client.chat.update({ channel, ts: messageTs, blocks: [], text: `✅ DM sent.` });
    return;
  }

  await client.chat.update({ channel, ts: messageTs, blocks: [], text: '⏳ Sending messages...' });

  const members = await getChannelMembers(client, pending.channelOverride || GENERAL_CHANNEL_ID);

  log.info('NOTIFY', `📢 Broadcast started by ${log.who(userId)} — ${members.length} recipients`);

  let sent = 0;
  let failed = 0;
  let firstError = null;

  const BATCH_SIZE = 20;
  for (let i = 0; i < members.length; i += BATCH_SIZE) {
    const batch = members.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (member) => {
        const dm = await client.conversations.open({ users: member.id });
        await client.chat.postMessage({
          channel: dm.channel.id,
          text: pending.messageText,
          unfurl_links: false,
        });
      })
    );
    for (const result of results) {
      if (result.status === 'fulfilled') sent++;
      else {
        failed++;
        log.warn('NOTIFY', `Failed to DM a member: ${result.reason?.message}`);
        if (!firstError) firstError = result.reason?.message;
      }
    }
  }

  log.info('NOTIFY', `✅ Broadcast complete — ${sent} sent, ${failed} failed`);
  analytics.track(userId, 'Broadcast Sent', { sent, failed, message: pending.messageText });

  await logAudit({ userId, userType: 'hr_admin', action: 'broadcast', question: pending.messageText, answer: null, citedDoc: null });

  await client.chat.update({
    channel,
    ts: messageTs,
    blocks: [],
    text: `✅ Message sent to *${sent}* people.${failed > 0 ? ` ${failed} failed.${firstError ? ` Error: \`${firstError}\`` : ' Check Vercel logs.'}` : ''}`,
  });
}

async function handleNotifyUser(client, channel, ts, messageText, userId, targetUserId) {
  const { name: targetName } = analytics.getUser(targetUserId);
  const actionId = randomUUID();
  pendingNotifications.set(actionId, { messageText, userId, targetUserId, createdAt: Date.now() });

  await client.chat.postMessage({
    channel,
    thread_ts: ts,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `You're about to send a DM to *${targetName}*:\n\n> ${messageText}\n\nShall I proceed?`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Send' },
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
    text: `About to DM ${targetName}: "${messageText}"`,
    unfurl_links: false,
  });
}

module.exports = { handleNotifyRequest, handleNotifyUser, handleNotifyAction };
