const { query: ragQuery } = require('../services/rag');
const { setUserPreference } = require('../services/supabase');
const { NOT_FOUND_MESSAGE } = require('../services/llm');
const { logUnansweredQuestion, logAudit } = require('../services/supabase');
const analytics = require('../services/analytics');
const log = require('../utils/logger');

const EMPLOYMENT_LABELS = {
  'full-time': 'full-time employee',
  contractor: 'contractor',
};

async function handleEmploymentTypeChoice({ action, body, client, ack }) {
  await ack();

  const userId = body.user.id;
  const channel = body.channel.id;
  const messageTs = body.message.ts;
  const threadTs = body.message.thread_ts || messageTs;

  // Value format: "<employment_type>|<original question>"
  const separatorIndex = action.value.indexOf('|');
  const employmentType = action.value.slice(0, separatorIndex);
  const originalQuestion = action.value.slice(separatorIndex + 1);

  await setUserPreference(userId, 'employment_type', employmentType);
  analytics.track(userId, 'Employment Type Set', { employment_type: employmentType });
  log.info('PREF', `👤 ${log.who(userId)} set employment_type = ${employmentType}`);

  const label = EMPLOYMENT_LABELS[employmentType] || employmentType;

  // Replace the button message with a plain confirmation
  await client.chat.update({
    channel,
    ts: messageTs,
    text: `Got it, I'll remember you're a *${label}*. Let me find your answer...`,
    blocks: [],
  });

  // Re-run RAG with employment type context injected
  const augmentedQuestion = `I am a ${label}. ${originalQuestion}`;
  const result = await ragQuery(augmentedQuestion, []);

  if (result) {
    log.info('PREF', `✅ Answer found for ${log.who(userId)} after employment type selection`);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: result.answer,
      unfurl_links: false,
    });
    analytics.track(userId, 'Answer Found', { question: originalQuestion, cited_doc: result.citedDoc || null });
    await logAudit({
      userId,
      userType: 'employee',
      action: 'query',
      question: originalQuestion,
      answer: result.answer,
      citedDoc: result.citedDoc || null,
    });
  } else {
    log.warn('PREF', `No answer found for ${log.who(userId)} after employment type selection`);
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: NOT_FOUND_MESSAGE, unfurl_links: false });
    await logUnansweredQuestion({ userId, questionText: originalQuestion, threadTs, channel });
    analytics.track(userId, 'Answer Not Found', { question: originalQuestion });
  }
}

module.exports = { handleEmploymentTypeChoice };
