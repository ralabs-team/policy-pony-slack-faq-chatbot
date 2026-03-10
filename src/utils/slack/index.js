/**
 * Download a private Slack file using the bot token for authorization.
 * Requires Node 18+ (uses built-in fetch).
 */
async function downloadSlackFile(url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download file from Slack (${response.status}: ${response.statusText})`);
  }

  return Buffer.from(await response.arrayBuffer());
}

module.exports = { downloadSlackFile };
