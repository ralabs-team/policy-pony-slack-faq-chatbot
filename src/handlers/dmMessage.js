const { handleEmployeeDm } = require('./employeeHandler');
const { handleHrAdminDm } = require('./hrAdminHandler');
const log = require('../utils/logger');

const HR_USER_IDS = (process.env.HR_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

function isHrAdmin(userId) {
  return HR_USER_IDS.includes(userId);
}

async function handleDmMessage({ message, client }) {
  const userId = message.user;
  if (!userId) return;

  const hasFile = Array.isArray(message.files) && message.files.length > 0;
  const preview = (message.text || '').slice(0, 60).replace(/\n/g, ' ');
  const role = isHrAdmin(userId) ? 'HR admin' : 'employee';

  log.info('MSG', `📨 DM from ${log.who(userId)} [${role}]${hasFile ? ` + file: ${message.files[0].name}` : ''} — "${preview}"`);

  if (isHrAdmin(userId)) {
    await handleHrAdminDm({ message, client });
  } else {
    await handleEmployeeDm({ message, client });
  }
}

module.exports = { handleDmMessage };
