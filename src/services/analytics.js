const Mixpanel = require('mixpanel');
const log = require('../utils/logger');

const mixpanel = process.env.MIXPANEL_TOKEN
  ? Mixpanel.init(process.env.MIXPANEL_TOKEN, {
      host: 'api-eu.mixpanel.com',
    })
  : null;

if (!mixpanel) {
  log.warn('ANALYTICS', '⚠️  MIXPANEL_TOKEN not set — analytics disabled');
}

// userId → { name, email } — populated on startup from Slack users.list
let usersCache = {};

function init(slackUsers = []) {
  for (const user of slackUsers) {
    if (!user.id || user.is_bot || user.deleted) continue;
    usersCache[user.id] = {
      name: user.profile?.display_name || user.profile?.real_name || user.name || user.id,
      email: user.profile?.email || null,
    };
  }
  log.info('ANALYTICS', `👤 User cache built — ${Object.keys(usersCache).length} users`);
}

function getUser(userId) {
  return usersCache[userId] || { name: userId, email: null };
}

function identify(userId) {
  if (!mixpanel) return;
  const { name, email } = getUser(userId);
  mixpanel.people.set(userId, {
    $name: name,
    ...(email ? { $email: email } : {}),
  });
}

function track(userId, event, properties = {}) {
  if (!mixpanel) return;
  const { name } = getUser(userId);
  mixpanel.track(event, {
    distinct_id: userId,
    username: name,
    ...properties,
  });
}

module.exports = { init, identify, track };
