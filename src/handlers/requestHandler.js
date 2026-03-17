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

module.exports = { handleUserRequestYes, handleUserRequestNo };
