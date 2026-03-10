const Mixpanel = require('mixpanel');
const log = require('../utils/logger');

const mixpanel = process.env.MIXPANEL_TOKEN
  ? Mixpanel.init(process.env.MIXPANEL_TOKEN, { host: 'api-eu.mixpanel.com' })
  : null;

if (!mixpanel) {
  log.warn('ANALYTICS', '⚠️  MIXPANEL_TOKEN not set — analytics disabled');
}

// userId → { name, email }
// Populated lazily on first request; persists across warm Vercel invocations
let usersCache = {};
let initialized = false;
let initInProgress = null;

async function ensureInit(client) {
  if (initialized) return;
  if (initInProgress) return initInProgress;

  initInProgress = (async () => {
    try {
      const result = await client.users.list({ limit: 1000 });
      const members = result.members || [];

      for (const user of members) {
        if (!user.id || user.is_bot || user.deleted) continue;
        usersCache[user.id] = {
          name: user.profile?.display_name || user.profile?.real_name || user.name || user.id,
          email: user.profile?.email || null,
        };
      }
      log.info('ANALYTICS', `👤 User cache built — ${Object.keys(usersCache).length} users`);

      // Validate HR_USER_IDS while we have the member list
      const hrIds = (process.env.HR_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
      if (hrIds.length === 0) {
        log.warn('ANALYTICS', '⚠️  HR_USER_IDS is not set — no one will have HR admin access');
      } else {
        const slackIds = new Set(members.map((u) => u.id));
        const invalid = hrIds.filter((id) => !slackIds.has(id));
        if (invalid.length > 0) {
          log.warn('ANALYTICS', `⚠️  Unknown HR user(s): ${invalid.join(', ')}`);
        } else {
          log.info('ANALYTICS', `✅ HR_USER_IDS validated — ${hrIds.length} admin(s) confirmed`);
        }
      }
    } catch (err) {
      log.warn('ANALYTICS', `⚠️  Could not fetch Slack users: ${err.message}`);
    } finally {
      initialized = true;
      initInProgress = null;
    }
  })();

  return initInProgress;
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

module.exports = { ensureInit, identify, track };
