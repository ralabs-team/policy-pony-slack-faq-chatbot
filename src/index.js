require('dotenv').config();

// @slack/socket-mode v1.x crashes on 'server explicit disconnect' — let nodemon restart cleanly
process.on('uncaughtException', (err) => {
  if (err.message?.includes('Unhandled event')) {
    console.warn('[WARN] Slack socket disconnected — restarting...');
    process.exit(1);
  }
  throw err;
});

// Validate required environment variables before anything else
const REQUIRED_ENV = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in all values.');
  process.exit(1);
}

const { App, LogLevel } = require('@slack/bolt');
const { handleDmMessage } = require('./handlers/dmMessage');
const { handleBlockAction, handleDeleteDocRequest } = require('./handlers/hrAdminHandler');
const { handleHelp } = require('./handlers/helpHandler');
const log = require('./utils/logger');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  // Suppress Bolt's verbose internal DEBUG logs — they accumulate in memory
  logLevel: LogLevel.ERROR,
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

// ── Periodic memory monitor ────────────────────────────────────────────────
// Logs heap usage every 30 s so you can see if memory grows at idle.
// If it climbs steadily even with no user activity, the leak is in Bolt/Supabase init.
// If it's flat until an upload, the leak is in the ingestion pipeline.
setInterval(() => {
  const { heapUsed, heapTotal } = process.memoryUsage();
  const used = (heapUsed / 1024 / 1024).toFixed(0);
  const total = (heapTotal / 1024 / 1024).toFixed(0);
  log.info('MEM', `heap ${used} MB used / ${total} MB allocated`);
}, 30_000);

(async () => {
  await app.start();
  log.info('MEM', `startup heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`);
  console.log('🦄 Policy Pony is running!');
})();
