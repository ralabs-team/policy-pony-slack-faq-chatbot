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
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const express = require('express');
const { receiver } = require('../src/app');

// Wrap receiver.app so the retry-drop middleware runs first.
// Bolt's router is mounted inside receiver.app at construction time,
// so any middleware added to receiver.app afterwards runs too late.
const handler = express();

// Drop Slack retries before Bolt processes them — prevents duplicate responses on Vercel.
handler.use((req, res, next) => {
  if (req.headers['x-slack-retry-num']) {
    return res.sendStatus(200);
  }
  next();
});

handler.use(receiver.app);

module.exports = handler;
