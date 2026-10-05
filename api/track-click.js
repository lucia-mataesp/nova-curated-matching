const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.status(500).json({ error: 'Server misconfigured: missing env vars' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  const suggestionId = body && body.suggestion_id;
  if (!suggestionId) {
    res.status(400).json({ error: 'Missing suggestion_id' });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  // Only set it the first time - a double-click or the beacon firing twice
  // shouldn't overwrite the original click timestamp.
  await supabase.from('suggestions').update({ clicked_at: new Date().toISOString() }).eq('id', suggestionId).is('clicked_at', null);

  res.status(200).json({ ok: true });
};
