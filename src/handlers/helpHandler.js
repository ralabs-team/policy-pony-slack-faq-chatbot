const analytics = require('../services/analytics');
const log = require('../utils/logger');

const HR_USER_IDS = (process.env.HR_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

function isHrAdmin(userId) {
  return HR_USER_IDS.includes(userId);
}

const EMPLOYEE_HELP = `*Hey! I'm Pony, your HR buddy* 👋

Think of me as your go-to for HR-related questions — from benefits and insurance to public holidays, time off, and vacation policies.

*Try asking:*
• Is March 8th a day off this year?
• What benefits are available?
• When is the next public holiday?
• What's the difference between vacation and sick leave?
• What do I need to know about joining the team?

Just send me a message and I'll get you a quick answer.

*Commands:*
• */pony-feedback [your message]* — share feedback or suggest a topic you'd like me to cover`;

const HR_HELP = `*Hey! I'm Pony, your HR buddy* 👋

*For employees* — I answer HR-related questions about benefits, holidays, time off, and company info.

*For you as HR admin, you can also:*
• *Upload a doc* — send a PDF or DOCX file to add or update a policy
• *delete* — shows all uploaded docs with delete buttons
• *delete [doc name]* — goes straight to delete confirmation (e.g. "delete Benefits Policy")
• *list documents* — shows all uploaded docs (no delete buttons)
• *update [doc name]* — attach a new file to replace an existing policy
• *notify everyone: [message]* — send a DM to all members of #general
• *notify everyone in #channel: [message]* — send a DM to all members of a specific channel
• *notify @person: [message]* — send a DM to a specific person

*Commands:*
• */pony-feedback [your message]* — share feedback or suggest a topic to add to our policies`;

async function handleHelp({ ack, body, client }) {
  await ack();

  const userId = body.user_id;
  const text = isHrAdmin(userId) ? HR_HELP : EMPLOYEE_HELP;

  const role = isHrAdmin(userId) ? 'hr_admin' : 'employee';
  log.info('HELP', `📖 /help requested by ${userId} [${role}]`);
  analytics.track(userId, 'Help Viewed', { role });

  await client.chat.postEphemeral({
    channel: body.channel_id,
    user: userId,
    text,
  });
}

module.exports = { handleHelp };
