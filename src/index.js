require('dotenv').config();

const REQUIRED_ENV = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
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

const { receiver } = require('./app');
const PORT = process.env.PORT || 3000;

receiver.app.listen(PORT, () => {
  console.log(`🦄 Policy Pony is running on port ${PORT}`);
  console.log(`   Expose it to Slack via: ngrok http ${PORT}`);
});
