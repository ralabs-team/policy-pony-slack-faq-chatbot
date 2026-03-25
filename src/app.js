const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const express = require('express');
const { handleDmMessage } = require('./handlers/dmMessage');
const { handleBlockAction, handleDeleteDocRequest } = require('./handlers/hrAdminHandler');
const { handleUserRequestYes, handleUserRequestNo, handleFeedback } = require('./handlers/requestHandler');
const { handleHelp } = require('./handlers/helpHandler');
const analytics = require('./services/analytics');
const log = require('./utils/logger');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // processBeforeResponse: true ensures the handler fully completes before Bolt
  // sends 200 to Slack. Required on Vercel — without it the function is terminated
  // after the response, killing the handler before chat.postMessage is called.
  processBeforeResponse: true,
  endpoints: '/api/slack',
});

// Parse JSON bodies before the URL verification check
receiver.app.use(express.json());

// Handle Slack URL verification challenge explicitly before Bolt processes anything.
// Slack sends this as a plain JSON POST — no signature verification needed.
receiver.app.use((req, res, next) => {
  if (req.body && req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }
  next();
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

// Handle user policy request buttons (yes/no after not-found)
app.action('user_request_yes', handleUserRequestYes);
app.action('user_request_no', handleUserRequestNo);

// /help slash command
app.command('/help', handleHelp);

// /feedback slash command
app.command('/pony-feedback', handleFeedback);

module.exports = { app, receiver };
