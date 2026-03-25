const { query: ragQuery } = require('../services/rag');
const { NOT_FOUND_MESSAGE, generateCapabilityResponse } = require('../services/llm');
const { logUnansweredQuestion, logAudit, listAllDocuments, sampleChunksPerDocument } = require('../services/supabase');
const analytics = require('../services/analytics');
const log = require('../utils/logger');

// Matches "how can you help", "what can I ask", "what do you know", etc. in EN and UA
const CAPABILITY_QUESTIONS = /\b(how (can|do) you help|what (can|do) you (do|know|help with|cover)|what (topics?|questions?|things?) (can|do)|what (can|should) i ask|what('s| is) your (purpose|role)|what are you (for|about))\b|(що ти (вмієш|можеш)|чим ти (можеш )?допомож|які (теми|питання)|що ти знаєш)/i;

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

    // Self-introduction — who/what are you?
    const SELF_INTRO = /\b(who|what) are you\b|\btell me about yourself\b|\bwhat('s| is) your (name|purpose|role)\b|\bintroduce yourself\b|(хто|що) ти (таке|такий)?\b|розкажи про себе/i;
    if (SELF_INTRO.test(text.trim())) {
      analytics.track(user, 'Self Intro');
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "I'm *Policy Pony* 🦄 — your friendly HR assistant at Ralabs! I can answer questions about company policies, benefits, time off, public holidays, and more. Just ask me anything HR-related and I'll do my best to help. What would you like to know?",
        unfurl_links: false,
      });
    }

    // Capability questions — list topics from currently uploaded documents
    if (CAPABILITY_QUESTIONS.test(text.trim())) {
      analytics.track(user, 'Capability Question');
      const docs = await listAllDocuments();
      const isUA = /[а-яіїєґА-ЯІЇЄҐ]/.test(text);
      let reply;
      if (docs.length > 0) {
        const chunksPerDoc = await sampleChunksPerDocument(docs.map((d) => d.doc_name), 3);
        reply = await generateCapabilityResponse(chunksPerDoc, isUA);
      } else {
        reply = isUA ? 'Поки що жодного документа не завантажено. Зверніться до HR.' : "No policy documents have been uploaded yet. Check back soon!";
      }
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({ channel, thread_ts: threadTs, text: reply, unfurl_links: false });
    }

    // Easter egg — Who is Roman?
    if (/who\s+is\s+roman(\s+r(odomansky[yi]?)?)?\s*\??$/i.test(text.trim())) {
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "That's Roman — COO of Ralabs and a genuinely great guy! He's deeply in love with JavaScript, Python, DevOps, and R&D. If it's cutting-edge and slightly nerdy, Roman's probably already tried it. 🚀",
        unfurl_links: false,
      });
    }

    // Easter egg — meaning of life
    if (/what('s| is) the meaning of life\??$/i.test(text.trim())) {
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: '42. But also: unlimited PTO would help.',
        unfurl_links: false,
      });
    }

    // Easter egg — better than ChatGPT?
    if (/are you better than chat\s*gpt\??$/i.test(text.trim())) {
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "I'm more focused. ChatGPT knows everything. I know Ralabs.",
        unfurl_links: false,
      });
    }

    // Easter egg — tell me a joke
    if (/tell me a joke\??$/i.test(text.trim())) {
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "Why did the employee read the HR policy twice? Because the first time, they fell asleep. 😄",
        unfurl_links: false,
      });
    }

    // Easter egg — do you like your job?
    if (/do you like your (job|work)\??$/i.test(text.trim())) {
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "Love it. People ask me about vacation days at 11pm on a Sunday and I'm just here, ready, no complaints. 🦄",
        unfurl_links: false,
      });
    }

    // Easter egg — salary questions
    if (/\b(salary|salaries|how much (does|do)|what (does|do) .+ (earn|make|get paid))\b/i.test(text.trim())) {
      await client.reactions.remove({ name: 'hourglass_flowing_sand', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'white_check_mark', channel, timestamp: ts }).catch(() => {});
      await client.reactions.add({ name: 'unicorn', channel, timestamp: ts }).catch(() => {});
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "I actually know everyone's salary. But Iryna Oliiarnyk made it very clear what would happen if I ever shared it. So. How about those public holidays?",
        unfurl_links: false,
      });
    }

    const result = await ragQuery(text, history);

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
      } else if (result.isPartialNotFound) {
        analytics.track(user, 'Answer Not Found', { question: text });
        await logUnansweredQuestion({ userId: user, questionText: text, threadTs, channel });
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: 'Would you like HR to review this and add it to our policies?',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: 'Would you like HR to review this and add it to our policies?' },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '👍 Yes, request it' },
                  style: 'primary',
                  action_id: 'user_request_yes',
                  value: text,
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'No thanks' },
                  action_id: 'user_request_no',
                  value: text,
                },
              ],
            },
          ],
          unfurl_links: false,
        });
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
        await logAudit({
          userId: user,
          userType: 'employee',
          action: 'query',
          question: text,
          answer: null,
          citedDoc: null,
        });
        // Ask if the user wants HR to review and add this to policies
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "Hmm, I couldn't find anything on that. Would you like HR to review this and add it to our policies?",
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: "Hmm, I couldn't find anything on that. Would you like HR to review this and add it to our policies?" },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '👍 Yes, request it' },
                  style: 'primary',
                  action_id: 'user_request_yes',
                  value: text,
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'No thanks' },
                  action_id: 'user_request_no',
                  value: text,
                },
              ],
            },
          ],
          unfurl_links: false,
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
