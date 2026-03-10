const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const { handleDmMessage } = require('./handlers/dmMessage');
const { handleBlockAction, handleDeleteDocRequest } = require('./handlers/hrAdminHandler');
const { handleHelp } = require('./handlers/helpHandler');
const analytics = require('./services/analytics');
const log = require('./utils/logger');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // processBeforeResponse ensures the handler completes before Bolt sends 200 to Slack.
  // Required for Vercel — without this the serverless function may terminate mid-handler.
  processBeforeResponse: true,
  endpoints: '/',
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.ERROR,
});

// Lazy-init analytics user cache on first request.
// Works for both Vercel (warm instance reuse) and local dev.
app.use(async ({ client, next }) => {
  await analytics.ensureInit(client);
  await next();
});

// Handle DM message events (employees + HR admins)
// app.event('message') is used (vs app.message) to also catch file_share subtypes
app.event('message', async ({ event, client }) => {
  if (event.channel_type !== 'im') return;
  if (event.bot_id || event.subtype === 'bot_message') return;
  await handleDmMessage({ message: event, client });
});

// Handle HR admin confirmation button clicks
app.action(/^(confirm|cancel)_action_.+/, handleBlockAction);

// Handle delete button clicks from the document list (HR only)
app.action('delete_doc_request', handleDeleteDocRequest);

// /help slash command
app.command('/help', handleHelp);

module.exports = { app, receiver };
