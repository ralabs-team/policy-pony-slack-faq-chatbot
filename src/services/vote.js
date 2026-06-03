const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: -1 } },
  }
);

async function createVoteSession({ question, options, channelId, recipientCount, createdBy }) {
  const { data, error } = await supabase
    .from('vote_sessions')
    .insert({
      question,
      options,
      channel_id: channelId || null,
      recipient_count: recipientCount,
      created_by: createdBy,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw new Error(`createVoteSession: ${error.message}`);
  return data;
}

async function updateVoteRecipients(voteId, recipients) {
  const { error } = await supabase
    .from('vote_sessions')
    .update({ recipients })
    .eq('id', voteId);
  if (error) throw new Error(`updateVoteRecipients: ${error.message}`);
}

async function recordVoteResponse({ voteId, userId, userName, optionIndex }) {
  const { error } = await supabase
    .from('vote_responses')
    .insert({ vote_id: voteId, user_id: userId, user_name: userName, option_index: optionIndex });
  if (error) {
    if (error.code === '23505') throw new Error('DUPLICATE');
    throw new Error(`recordVoteResponse: ${error.message}`);
  }
}

async function getVoteSession(voteId) {
  const { data, error } = await supabase
    .from('vote_sessions')
    .select('*')
    .eq('id', voteId)
    .single();
  if (error) throw new Error(`getVoteSession: ${error.message}`);
  return data;
}

async function getVoteResults(voteId) {
  const { data: session, error: sErr } = await supabase
    .from('vote_sessions')
    .select('*')
    .eq('id', voteId)
    .single();
  if (sErr) throw new Error(`getVoteResults: ${sErr.message}`);

  const { data: responses, error: rErr } = await supabase
    .from('vote_responses')
    .select('*')
    .eq('vote_id', voteId)
    .order('voted_at', { ascending: true });
  if (rErr) throw new Error(`getVoteResults: ${rErr.message}`);

  const options = Array.isArray(session.options) ? session.options : JSON.parse(session.options);
  const counts = options.map(() => []);
  for (const r of responses || []) {
    if (counts[r.option_index] !== undefined) {
      counts[r.option_index].push(r.user_name || r.user_id);
    }
  }

  return {
    question: session.question,
    options,
    counts,
    responseCount: (responses || []).length,
    recipientCount: session.recipient_count,
    status: session.status,
  };
}

async function getLatestActiveVote(createdBy) {
  const { data, error } = await supabase
    .from('vote_sessions')
    .select('*')
    .eq('created_by', createdBy)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw new Error(`getLatestActiveVote: ${error.message}`);
  return data || null;
}

async function getLatestVoteByCreator(createdBy) {
  const { data, error } = await supabase
    .from('vote_sessions')
    .select('*')
    .eq('created_by', createdBy)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw new Error(`getLatestVoteByCreator: ${error.message}`);
  return data || null;
}

async function closeVoteSession(voteId) {
  const { error } = await supabase
    .from('vote_sessions')
    .update({ status: 'closed' })
    .eq('id', voteId);
  if (error) throw new Error(`closeVoteSession: ${error.message}`);
}

async function getVoteResponseByUser(voteId, userId) {
  const { data, error } = await supabase
    .from('vote_responses')
    .select('option_index')
    .eq('vote_id', voteId)
    .eq('user_id', userId)
    .single();
  if (error && error.code !== 'PGRST116') return null;
  return data || null;
}

async function getVotedUserIds(voteId) {
  const { data, error } = await supabase
    .from('vote_responses')
    .select('user_id')
    .eq('vote_id', voteId);
  if (error) throw new Error(`getVotedUserIds: ${error.message}`);
  return (data || []).map((r) => r.user_id);
}

module.exports = {
  createVoteSession,
  updateVoteRecipients,
  recordVoteResponse,
  getVoteSession,
  getVoteResults,
  getLatestActiveVote,
  getLatestVoteByCreator,
  closeVoteSession,
  getVoteResponseByUser,
  getVotedUserIds,
};
