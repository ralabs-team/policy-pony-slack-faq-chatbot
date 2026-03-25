const { logUserRequest } = require('../services/supabase');
const analytics = require('../services/analytics');
const log = require('../utils/logger');

async function handleUserRequestYes({ ack, body, client, action }) {
  await ack();

  const userId = body.user.id;
  const channel = body.channel.id;
  const messageTs = body.message.ts;
  const threadTs = body.message.thread_ts || messageTs;
  const questionText = action.value;
  const { name: userName } = analytics.getUser(userId);

  await logUserRequest({ userId, userName, questionText, channel, threadTs });
  analytics.track(userId, 'Policy Request Submitted', { question: questionText });
  log.info('REQUEST', `📝 ${log.who(userId)} (${userName}) requested: "${questionText.slice(0, 80)}"`);

  await client.chat.update({
    channel,
    ts: messageTs,
    text: "Got it — I've noted your request. HR will review it and may add it to our policies in the future.",
    blocks: [],
  });
}

async function handleUserRequestNo({ ack, body, client }) {
  await ack();

  const channel = body.channel.id;
  const messageTs = body.message.ts;

  await client.chat.update({
    channel,
    ts: messageTs,
    text: "No problem! If you think of anything else, feel free to ask.",
    blocks: [],
  });
}

async function handleFeedback({ ack, body, client }) {
  await ack();

  const userId = body.user_id;
  const channel = body.channel_id;
  const feedbackText = (body.text || '').trim();
  const { name: userName } = analytics.getUser(userId);

  if (!feedbackText) {
    return client.chat.postEphemeral({
      channel,
      user: userId,
      text: 'Please include your feedback after the command, e.g. `/feedback I\'d love to see info about gym benefits`',
    });
  }

  await logUserRequest({ userId, userName, questionText: feedbackText, channel, threadTs: null });
  analytics.track(userId, 'Feedback Submitted', { feedback: feedbackText });
  log.info('FEEDBACK', `💬 ${log.who(userId)} (${userName}): "${feedbackText.slice(0, 80)}"`);

  await client.chat.postEphemeral({
    channel,
    user: userId,
    text: 'Thanks for the feedback! 🦄 HR will review it.',
  });
}

module.exports = { handleUserRequestYes, handleUserRequestNo, handleFeedback };
