function ts() {
  return new Date().toTimeString().slice(0, 8); // HH:MM:SS
}

// Parse USER_NAMES=U123:Alice,U456:Bob into a Map
const nameMap = new Map(
  (process.env.USER_NAMES || '')
    .split(',')
    .map((entry) => entry.split(':').map((s) => s.trim()))
    .filter(([id, name]) => id && name)
);

// Returns "Alice (U123)" if known, otherwise just "U123"
function who(userId) {
  const name = nameMap.get(userId);
  return name ? `${name} (${userId})` : userId;
}

const log = {
  info:  (tag, msg) => console.log(`[${ts()}] [${tag}] ${msg}`),
  warn:  (tag, msg) => console.warn(`[${ts()}] [${tag}] ⚠️  ${msg}`),
  error: (tag, msg, err) => console.error(`[${ts()}] [${tag}] ❌ ${msg}`, err?.message || err || ''),
  who,
};

module.exports = log;
