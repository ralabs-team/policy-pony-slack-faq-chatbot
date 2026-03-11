const { query: ragQuery } = require('../services/rag');
const { NOT_FOUND_MESSAGE } = require('../services/llm');
const { logUnansweredQuestion, logAudit, getUserPreference } = require('../services/supabase');
const analytics = require('../services/analytics');
const log = require('../utils/logger');

// Questions where the answer differs for full-time employees vs contractors
const NEEDS_EMPLOYMENT_TYPE = /\b(benefit|sick\s*leave|sick\s*day|equipment|laptop|hardware|onboard|offboard|educat|certif|reimburs|insurance|compens)\b/i;

const GREETINGS_EN = /^(hi|hey|hello|howdy|hiya|sup|yo|greetings|good morning|good afternoon|good evening)[\s!.,]*$/i;
const GREETINGS_UA = /^(привіт|добрий день|добридень|доброго ранку|вітаю)[\s!.,]*$/i;

const SMALL_TALK = /^(thanks|thank you|thx|ty|дякую|спасибо|дяки|супер|добре|окей|ок|great|cool|awesome|nice|perfect|got it|understood|makes sense|sounds good|no worries|no problem|you('re| are) welcome|haha|lol|😊|👍|bye|goodbye|see you|бувай|до побачення|як справи|how are you|i('m| am) (good|fine|ok|great)|not bad)[\s!.,?]*$/i;

const SMALL_TALK_REPLIES_EN = [
  "Happy to help! What's your question?",
  "Sure thing! What would you like to know?",
  "Of course! What can I help you with?",
];
const SMALL_TALK_REPLIES_UA = [
  "Звісно! Чим можу допомогти?",
  "Залюбки! Що хочеш дізнатися?",
  "Гаразд! Яке у тебе питання?",
];

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function handleEmployeeDm({ message, client }) {
  const { channel, ts, thread_ts, text, user } = message;
  if (!text || text.trim() === '') return;

  const threadTs = thread_ts || ts;
  const preview = text.slice(0, 80).replace(/\n/g, ' ');
  log.info('QUERY', `🔍 ${log.who(user)}: "${preview}"`);

  // Require at least 3 characters
  if (text.trim().length < 3) {
    analytics.track(user, 'Message Too Short', { message: text });
    return client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Could you give me a bit more to go on? Send at least a few characters and I'll do my best to help.",
      unfurl_links: false,
    });
  }

  analytics.identify(user);

  // Signal that the bot is thinking
  await client.reactions.add({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
  await client.reactions.add({ name: 'robot_face', channel, timestamp: ts }).catch(() => {});

  try {
    const history = await getThreadHistory(client, channel, threadTs, ts);
    log.info('QUERY', `📜 Thread context: ${history.length} previous message(s)`);

    // Protect context window — ask user to start a new thread if history is too long
    if (history.length >= 10) {
      analytics.track(user, 'Thread Too Long', { thread_length: history.length });
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "This thread is getting quite long and I'm losing context. Could you start a new thread and ask your question there?",
        unfurl_links: false,
      });
    }

    // If the user sends a greeting, respond warmly without running RAG
    const trimmed = text.trim();
    const isUaGreeting = GREETINGS_UA.test(trimmed);
    const isEnGreeting = GREETINGS_EN.test(trimmed);
    if (isUaGreeting || isEnGreeting) {
      analytics.track(user, 'Greeting');
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: isUaGreeting ? "Привіт! Чим можу допомогти?" : "Hey! What can I help you with today?",
        unfurl_links: false,
      });
    }

    // If the user replies with a short affirmative to "anything else?", ask them to specify
    const AFFIRMATIVES = /^(yes|yeah|yep|yup|sure|ok|okay|please|go ahead|tell me more|more|and\??)\.?!?$/i;
    if (AFFIRMATIVES.test(text.trim()) && history.length > 0) {
      analytics.track(user, 'Follow Up Request');
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

    // For employment-sensitive questions, check stored preference or ask
    let questionForRag = text;
    if (NEEDS_EMPLOYMENT_TYPE.test(text)) {
      const employmentType = await getUserPreference(user, 'employment_type');
      if (employmentType) {
        questionForRag = `I am a ${employmentType} employee. ${text}`;
        log.info('QUERY', `Using stored employment type: ${employmentType}`);
      } else {
        await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
        await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
        await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
        return client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: 'To give you the right answer — are you a full-time employee or a contractor?',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: 'To give you the right answer — are you a full-time employee or a contractor?' },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Full-time employee' },
                  action_id: 'set_employment_type',
                  value: `full-time|${text}`,
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Contractor' },
                  action_id: 'set_employment_type',
                  value: `contractor|${text}`,
                },
              ],
            },
          ],
          unfurl_links: false,
        });
      }
    }

    const result = await ragQuery(questionForRag, history);

    analytics.track(user, 'Message Received', { question: text, thread_length: history.length });

    if (result) {
      log.info('QUERY', `✅ Answer found — cited: "${result.citedDoc || 'n/a'}"${result.isSensitive ? ' [sensitive topic]' : ''}`);

      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: result.answer,
        unfurl_links: false,
      });
      log.info('QUERY', `💬 Reply sent to ${log.who(user)}`);

      if (result.isSensitive) {
        analytics.track(user, 'Sensitive Topic', { question: text });
      } else {
        analytics.track(user, 'Answer Found', { question: text, cited_doc: result.citedDoc || null });
      }

      await logAudit({
        userId: user,
        userType: 'employee',
        action: 'query',
        question: text,
        answer: result.answer,
        citedDoc: result.citedDoc || null,
      });
    } else {
      const isUA = /[а-яіїєґА-ЯІЇЄҐ]/.test(text);
      const smallTalk = SMALL_TALK.test(text.trim());

      if (smallTalk) {
        log.info('QUERY', `💬 Small talk from ${log.who(user)} — not logged as unanswered`);
        analytics.track(user, 'Small Talk', { message: text });
        const reply = randomPick(isUA ? SMALL_TALK_REPLIES_UA : SMALL_TALK_REPLIES_EN);
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply, unfurl_links: false });
      } else {
        log.warn('QUERY', `No answer found for ${log.who(user)}: "${preview}" — logged as unanswered`);
        analytics.track(user, 'Answer Not Found', { question: text });
        await logUnansweredQuestion({ userId: user, questionText: text, threadTs, channel });
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: NOT_FOUND_MESSAGE });
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
      text: 'Something went wrong. Please try again.',
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

    return messages;
  } catch {
    return [];
  }
}

module.exports = { handleEmployeeDm };
