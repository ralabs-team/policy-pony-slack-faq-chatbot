const { randomUUID } = require('crypto');
const analytics = require('../services/analytics');
const log = require('../utils/logger');
const {
  createVoteSession,
  updateVoteRecipients,
  recordVoteResponse,
  getVoteSession,
  getVoteResults,
  getLatestActiveVote,
  getLatestVoteByCreator,
  closeVoteSession,
  getVoteResponseByUser,
  getVotedUserIds,
  getActiveVotes,
  getResponseCount,
} = require('../services/vote');
const { getChannelMembers } = require('./notifyHandler');

const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID;

// In-memory store for pending vote confirmations, auto-expire after 10 min
const pendingVotes = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, v] of pendingVotes.entries()) {
    if (now - v.createdAt > 10 * 60 * 1000) pendingVotes.delete(key);
  }
}, 60 * 1000);

// Builds the vote blocks for employee DMs.
// Slack actions blocks allow max 5 elements, so split into two rows if needed.
function buildVoteBlocks(voteId, question, options) {
  const buttons = options.map((opt, i) => ({
    type: 'button',
    text: { type: 'plain_text', text: opt },
    action_id: `vote_option_${voteId}_${i}`,
    value: `${voteId}:${i}`,
  }));

  const actionBlocks = [];
  for (let i = 0; i < buttons.length; i += 5) {
    actionBlocks.push({ type: 'actions', elements: buttons.slice(i, i + 5) });
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Quick vote from HR:*\n\n*${question}*` },
    },
    ...actionBlocks,
  ];
}

function formatResultsText(question, options, counts, responseCount, recipientCount, status) {
  const statusLabel = status === 'closed' ? ' _(closed)_' : '';
  const lines = options.map((opt, i) => {
    const voters = counts[i];
    let names = '';
    if (voters.length > 0) {
      const shown = voters.slice(0, 10);
      const extra = voters.length - shown.length;
      names = ` (${shown.join(', ')}${extra > 0 ? `, and ${extra} more` : ''})`;
    }
    return `• *${opt}* — ${voters.length} vote${voters.length !== 1 ? 's' : ''}${names}`;
  });
  return `Results for: *"${question}"*${statusLabel} (${responseCount} / ${recipientCount} responded)\n\n${lines.join('\n')}`;
}

async function handleVoteRequest(client, channel, ts, question, options, userId, channelOverride) {
  if (options.length < 2 || options.length > 6) {
    return client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `Please provide between 2 and 6 options separated by \`|\`. You provided ${options.length}.`,
    });
  }

  const targetChannelId = channelOverride || GENERAL_CHANNEL_ID;
  let members;
  try {
    members = await getChannelMembers(client, targetChannelId);
  } catch (err) {
    return client.chat.postMessage({ channel, thread_ts: ts, text: `Could not fetch channel members: ${err.message}` });
  }

  const actionId = randomUUID();
  pendingVotes.set(actionId, { question, options, channelOverride, userId, members, createdAt: Date.now() });

  const optionsList = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const previewText = `You're about to send a vote to *${members.length} people*:\n\n*${question}*\n${optionsList}\n\nShall I proceed?`;

  log.info('VOTE', `Awaiting confirmation from ${log.who(userId)}: "${question}" (${options.length} options, ${members.length} recipients) [action: ${actionId.slice(0, 8)}...]`);

  await client.chat.postMessage({
    channel,
    thread_ts: ts,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: previewText } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Send vote' },
            style: 'primary',
            action_id: `confirm_vote_${actionId}`,
            value: actionId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cancel' },
            style: 'danger',
            action_id: `cancel_vote_${actionId}`,
            value: actionId,
          },
        ],
      },
    ],
    text: previewText,
  });
}

async function handleVoteConfirmAction({ ack, body, client, action }) {
  await ack();

  const actionId = action.value;
  const pending = pendingVotes.get(actionId);
  const channel = body.channel?.id;
  const messageTs = body.message?.ts;

  if (!pending) {
    await client.chat
      .update({ channel, ts: messageTs, blocks: [], text: 'This vote request expired. Please send the vote command again.' })
      .catch(() => {});
    return;
  }

  const isConfirm = action.action_id.startsWith('confirm_vote_');
  pendingVotes.delete(actionId);

  if (!isConfirm) {
    log.info('VOTE', `Vote cancelled by ${log.who(body.user?.id)}`);
    await client.chat.update({ channel, ts: messageTs, blocks: [], text: 'Vote cancelled.' }).catch(() => {});
    return;
  }

  await client.chat.update({ channel, ts: messageTs, blocks: [], text: 'Sending vote...' }).catch(() => {});

  const targetChannelId = pending.channelOverride || GENERAL_CHANNEL_ID;
  let session;
  try {
    session = await createVoteSession({
      question: pending.question,
      options: pending.options,
      channelId: targetChannelId,
      recipientCount: pending.members.length,
      createdBy: pending.userId,
    });
  } catch (err) {
    log.error('VOTE', `Failed to create vote session`, err);
    await client.chat.update({ channel, ts: messageTs, blocks: [], text: `Failed to create vote: ${err.message}` }).catch(() => {});
    return;
  }

  const voteId = session.id;
  const { question, options, members } = pending;

  let sent = 0;
  let failed = 0;
  const recipients = [];

  const BATCH_SIZE = 20;
  for (let i = 0; i < members.length; i += BATCH_SIZE) {
    const batch = members.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (member) => {
        const dm = await client.conversations.open({ users: member.id });
        const dmChannelId = dm.channel.id;
        const msg = await client.chat.postMessage({
          channel: dmChannelId,
          blocks: buildVoteBlocks(voteId, question, options),
          text: `Quick vote: ${question}`,
        });
        return { userId: member.id, dmChannelId, messageTs: msg.ts };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        sent++;
        recipients.push(result.value);
      } else {
        failed++;
        log.warn('VOTE', `Failed to DM member: ${result.reason?.message}`);
      }
    }
  }

  await updateVoteRecipients(voteId, recipients).catch((err) =>
    log.warn('VOTE', `Failed to store recipients: ${err.message}`)
  );

  log.info('VOTE', `Vote "${question}" sent — ${sent} sent, ${failed} failed [id: ${voteId.slice(0, 8)}...]`);
  analytics.track(pending.userId, 'Vote Sent', { question, option_count: options.length, sent, failed });

  await client.chat
    .update({
      channel,
      ts: messageTs,
      text: `Vote sent to *${sent}* people.${failed > 0 ? ` (${failed} failed)` : ''}`,
    })
    .catch(() => {});
}

async function handleVoteResponse({ ack, body, client, action }) {
  await ack();

  const userId = body.user?.id;
  const channel = body.channel?.id;
  const messageTs = body.message?.ts;

  // action.value format: "{voteId}:{optionIndex}"
  const colonIdx = action.value.lastIndexOf(':');
  const voteId = action.value.slice(0, colonIdx);
  const optionIndex = parseInt(action.value.slice(colonIdx + 1), 10);

  let session;
  try {
    session = await getVoteSession(voteId);
  } catch {
    await client.chat.update({ channel, ts: messageTs, blocks: [], text: 'Vote not found.' }).catch(() => {});
    return;
  }

  const options = Array.isArray(session.options) ? session.options : JSON.parse(session.options);

  if (session.status === 'closed') {
    await client.chat
      .update({ channel, ts: messageTs, blocks: [], text: 'This vote has been closed. No further responses are accepted.' })
      .catch(() => {});
    return;
  }

  const existing = await getVoteResponseByUser(voteId, userId);
  if (existing) {
    await client.chat
      .update({ channel, ts: messageTs, blocks: [], text: `You already voted for *${options[existing.option_index]}*.` })
      .catch(() => {});
    return;
  }

  const { name: userName } = analytics.getUser(userId);
  try {
    await recordVoteResponse({ voteId, userId, userName, optionIndex });
  } catch (err) {
    if (err.message === 'DUPLICATE') {
      // Race condition — re-fetch and show the existing vote
      const recheck = await getVoteResponseByUser(voteId, userId);
      const label = recheck ? options[recheck.option_index] : options[optionIndex];
      await client.chat
        .update({ channel, ts: messageTs, blocks: [], text: `You already voted for *${label}*.` })
        .catch(() => {});
      return;
    }
    log.error('VOTE', `Failed to record vote response for ${log.who(userId)}`, err);
    await client.chat
      .update({ channel, ts: messageTs, blocks: [], text: 'Something went wrong recording your vote. Please try again.' })
      .catch(() => {});
    return;
  }

  log.info('VOTE', `${log.who(userId)} voted for "${options[optionIndex]}" on vote ${voteId.slice(0, 8)}...`);
  analytics.track(userId, 'Vote Response', { vote_id: voteId, option: options[optionIndex] });

  await client.chat
    .update({
      channel,
      ts: messageTs,
      blocks: [],
      text: `Thanks! You voted for *${options[optionIndex]}* on: _${session.question}_`,
    })
    .catch(() => {});

  // Notify HR if all votes are in
  const results = await getVoteResults(voteId).catch(() => null);
  if (results && results.responseCount >= results.recipientCount) {
    try {
      const dm = await client.conversations.open({ users: session.created_by });
      await client.chat.postMessage({
        channel: dm.channel.id,
        text: `All votes are in for: *"${session.question}"* — type \`vote results\` to see the tally.`,
      });
    } catch (err) {
      log.warn('VOTE', `Failed to notify HR of complete vote: ${err.message}`);
    }
  }
}

async function handleVoteResults(client, channel, ts, userId) {
  let session;
  try {
    session = await getLatestVoteByCreator(userId);
  } catch (err) {
    return client.chat.postMessage({ channel, thread_ts: ts, text: `Could not fetch vote: ${err.message}` });
  }

  if (!session) {
    return client.chat.postMessage({ channel, thread_ts: ts, text: 'No votes found.' });
  }

  const results = await getVoteResults(session.id);
  const text = formatResultsText(
    results.question,
    results.options,
    results.counts,
    results.responseCount,
    results.recipientCount,
    results.status
  );

  await client.chat.postMessage({ channel, thread_ts: ts, text });
}

async function handleCloseVote(client, channel, ts, userId) {
  let session;
  try {
    session = await getLatestActiveVote(userId);
  } catch (err) {
    return client.chat.postMessage({ channel, thread_ts: ts, text: `Could not fetch vote: ${err.message}` });
  }

  if (!session) {
    return client.chat.postMessage({ channel, thread_ts: ts, text: 'No active vote found.' });
  }

  await closeVoteSession(session.id);
  log.info('VOTE', `Vote "${session.question}" closed by ${log.who(userId)} [id: ${session.id.slice(0, 8)}...]`);

  const results = await getVoteResults(session.id);
  const text = formatResultsText(
    results.question,
    results.options,
    results.counts,
    results.responseCount,
    results.recipientCount,
    'closed'
  );

  await client.chat.postMessage({ channel, thread_ts: ts, text: `Vote closed.\n\n${text}` });

  // Update unreached recipients' DM messages
  const recipients = Array.isArray(session.recipients) ? session.recipients : JSON.parse(session.recipients || '[]');
  if (recipients.length === 0) return;

  let votedSet;
  try {
    const votedIds = await getVotedUserIds(session.id);
    votedSet = new Set(votedIds);
  } catch (err) {
    log.warn('VOTE', `Could not fetch voted user IDs for close: ${err.message}`);
    return;
  }

  const unvoted = recipients.filter((r) => !votedSet.has(r.userId));
  if (unvoted.length === 0) return;

  const BATCH_SIZE = 20;
  for (let i = 0; i < unvoted.length; i += BATCH_SIZE) {
    const batch = unvoted.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map((r) =>
        client.chat
          .update({
            channel: r.dmChannelId,
            ts: r.messageTs,
            blocks: [],
            text: 'This vote has been closed. No further responses are accepted.',
          })
          .catch((err) => log.warn('VOTE', `Could not update closed DM for ${r.userId}: ${err.message}`))
      )
    );
  }
}

async function buildActiveVoteBlocks(sessions) {
  if (sessions.length === 0) return null;

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Active votes (${sessions.length}):*` } },
    { type: 'divider' },
  ];

  for (const session of sessions) {
    const count = await getResponseCount(session.id);
    const question = session.question.length > 80 ? session.question.slice(0, 80) + '…' : session.question;
    const { name: creatorName } = require('../services/analytics').getUser(session.created_by);

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${question}*\n${count} / ${session.recipient_count} answered  ·  _by ${creatorName}_` },
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Results' },
          action_id: `vote_show_results_${session.id}`,
          value: session.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Close vote' },
          style: 'danger',
          action_id: `vote_close_${session.id}`,
          value: session.id,
        },
      ],
    });
    blocks.push({ type: 'divider' });
  }

  return blocks;
}

async function handleListActiveVotes(client, channel, ts, userId) {
  let sessions;
  try {
    sessions = await getActiveVotes();
  } catch (err) {
    return client.chat.postMessage({ channel, thread_ts: ts, text: `Could not fetch active votes: ${err.message}` });
  }

  if (sessions.length === 0) {
    return client.chat.postMessage({ channel, thread_ts: ts, text: 'No active votes at the moment.' });
  }

  const blocks = await buildActiveVoteBlocks(sessions);
  await client.chat.postMessage({ channel, thread_ts: ts, blocks, text: `Active votes (${sessions.length})` });
}

async function handleVoteResultsButton({ ack, body, client, action }) {
  await ack();

  const voteId = action.value;
  const channel = body.channel?.id;
  const messageTs = body.message?.ts;

  let results;
  try {
    results = await getVoteResults(voteId);
  } catch (err) {
    await client.chat.postMessage({ channel, text: `Could not fetch results: ${err.message}` });
    return;
  }

  const text = formatResultsText(
    results.question,
    results.options,
    results.counts,
    results.responseCount,
    results.recipientCount,
    results.status
  );

  await client.chat.postMessage({ channel, thread_ts: messageTs, text });
}

async function handleCloseVoteButton({ ack, body, client, action }) {
  await ack();

  const voteId = action.value;
  const userId = body.user?.id;
  const channel = body.channel?.id;
  const messageTs = body.message?.ts;

  let session;
  try {
    session = await getVoteSession(voteId);
  } catch (err) {
    await client.chat.postMessage({ channel, text: `Could not fetch vote: ${err.message}` });
    return;
  }

  if (session.status === 'closed') {
    await client.chat.postMessage({ channel, thread_ts: messageTs, text: 'This vote is already closed.' });
    return;
  }

  await closeVoteSession(voteId);
  log.info('VOTE', `Vote "${session.question}" closed by ${log.who(userId)} via button [id: ${voteId.slice(0, 8)}...]`);

  // Post final results as a reply to the list message
  const results = await getVoteResults(voteId);
  const text = formatResultsText(
    results.question,
    results.options,
    results.counts,
    results.responseCount,
    results.recipientCount,
    'closed'
  );
  await client.chat.postMessage({ channel, thread_ts: messageTs, text: `Vote closed.\n\n${text}` });

  // Refresh the active votes list
  const remaining = await getActiveVotes().catch(() => null);
  if (remaining !== null) {
    if (remaining.length === 0) {
      await client.chat.update({ channel, ts: messageTs, blocks: [], text: 'No active votes at the moment.' }).catch(() => {});
    } else {
      const blocks = await buildActiveVoteBlocks(remaining);
      await client.chat.update({ channel, ts: messageTs, blocks, text: `Active votes (${remaining.length})` }).catch(() => {});
    }
  }

  // Update unvoted recipients' DMs
  const recipients = Array.isArray(session.recipients) ? session.recipients : JSON.parse(session.recipients || '[]');
  if (recipients.length === 0) return;

  const votedIds = await getVotedUserIds(voteId).catch(() => []);
  const votedSet = new Set(votedIds);
  const unvoted = recipients.filter((r) => !votedSet.has(r.userId));

  const BATCH_SIZE = 20;
  for (let i = 0; i < unvoted.length; i += BATCH_SIZE) {
    const batch = unvoted.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map((r) =>
        client.chat
          .update({ channel: r.dmChannelId, ts: r.messageTs, blocks: [], text: 'This vote has been closed. No further responses are accepted.' })
          .catch((err) => log.warn('VOTE', `Could not update closed DM for ${r.userId}: ${err.message}`))
      )
    );
  }
}

module.exports = {
  handleVoteRequest,
  handleVoteConfirmAction,
  handleVoteResponse,
  handleVoteResults,
  handleCloseVote,
  handleListActiveVotes,
  handleVoteResultsButton,
  handleCloseVoteButton,
};
