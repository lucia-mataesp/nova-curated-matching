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

  const { type, id, value } = body || {};
  if (!id || !type) {
    res.status(400).json({ error: 'Missing type or id' });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  if (type === 'form') {
    const rating = parseInt(value, 10);
    if (!(rating >= 1 && rating <= 5)) {
      res.status(400).json({ error: 'form rating must be 1-5' });
      return;
    }
    // Only set once - don't let a double-click or re-render overwrite the first answer.
    await supabase.from('responses').update({ form_rating: rating }).eq('id', id).is('form_rating', null);
  } else if (type === 'match') {
    if (value !== 'up' && value !== 'down') {
      res.status(400).json({ error: 'match feedback must be up or down' });
      return;
    }
    await supabase.from('suggestions').update({ feedback: value }).eq('id', id).is('feedback', null);
  } else {
    res.status(400).json({ error: 'Unknown feedback type' });
    return;
  }

  res.status(200).json({ ok: true });
};
