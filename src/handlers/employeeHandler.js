const { query: ragQuery } = require('../services/rag');
const { generateNotFoundResponse, isSmallTalk, generateSmallTalkResponse } = require('../services/claude');
const { logUnansweredQuestion, logAudit } = require('../services/supabase');
const log = require('../utils/logger');

async function handleEmployeeDm({ message, client }) {
  const { channel, ts, thread_ts, text, user } = message;
  if (!text || text.trim() === '') return;

  const threadTs = thread_ts || ts;
  const preview = text.slice(0, 80).replace(/\n/g, ' ');
  log.info('QUERY', `🔍 ${log.who(user)}: "${preview}"`);

  // Require at least 3 characters
  if (text.trim().length < 3) {
    return client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Could you give me a bit more to go on? Send at least a few characters and I'll do my best to help.",
      unfurl_links: false,
    });
  }

  // Signal that the bot is thinking
  await client.reactions.add({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
  await client.reactions.add({ name: 'robot_face', channel, timestamp: ts }).catch(() => {});

  try {
    const history = await getThreadHistory(client, channel, threadTs, ts);
    log.info('QUERY', `📜 Thread context: ${history.length} previous message(s)`);

    // If the user sends a greeting, respond warmly without running RAG
    const GREETINGS = /^(hi|hey|hello|howdy|hiya|sup|yo|greetings|good morning|good afternoon|good evening|привіт|добрий день|добридень|доброго ранку)[\s!.,]*$/i;
    if (GREETINGS.test(text.trim())) {
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "Hey! What can I help you with today?",
        unfurl_links: false,
      });
    }

    // If the user replies with a short affirmative to "anything else?", ask them to specify
    const AFFIRMATIVES = /^(yes|yeah|yep|yup|sure|ok|okay|please|go ahead|tell me more|more|and\??)\.?!?$/i;
    if (AFFIRMATIVES.test(text.trim()) && history.length > 0) {
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "What would you like to know more about?",
        unfurl_links: false,
      });
    }

    const result = await ragQuery(text, history);

    if (result) {
      log.info('QUERY', `✅ Answer found — cited: "${result.citedDoc || 'n/a'}"${result.isSensitive ? ' [sensitive topic]' : ''}`);

      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: result.answer,
        unfurl_links: false,
      });
      log.info('QUERY', `💬 Reply sent to ${log.who(user)}`);

      await logAudit({
        userId: user,
        userType: 'employee',
        action: 'query',
        question: text,
        answer: result.answer,
        citedDoc: result.citedDoc || null,
      });
    } else {
      const smallTalk = await isSmallTalk(text);

      if (smallTalk) {
        log.info('QUERY', `💬 Small talk from ${log.who(user)} — not logged as unanswered`);
        const reply = await generateSmallTalkResponse(text);
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply, unfurl_links: false });
      } else {
        log.warn('QUERY', `No answer found for ${log.who(user)}: "${preview}" — logged as unanswered`);
        await logUnansweredQuestion({ userId: user, questionText: text, threadTs, channel });
        const notFoundMsg = await generateNotFoundResponse(text);
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: notFoundMsg });
        await logAudit({
          userId: user,
          userType: 'employee',
          action: 'query',
          question: text,
          answer: null,
          citedDoc: null,
        });
      }
    }

    await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
    await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
  } catch (err) {
    log.error('QUERY', `Failed to handle message from ${log.who(user)}`, err);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: 'Sorry, I ran into an error processing your request. Please try again.',
    });
  } finally {
    await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
  }
}

async function getThreadHistory(client, channel, threadTs, currentTs) {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });

    const messages = (result.messages || [])
      .filter((m) => m.ts !== currentTs)
      .slice(-10)
      .map((m) => ({
        role: m.bot_id ? 'assistant' : 'user',
        content: m.text || '',
      }))
      .filter((m) => m.content.trim() !== '');

    if (messages.length >= 10) {
      messages.unshift({
        role: 'user',
        content: '[Note: earlier messages in this thread were truncated. Please start a new thread if context is missing.]',
      });
    }

    return messages;
  } catch {
    return [];
  }
}

module.exports = { handleEmployeeDm };
