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

  const { type, id, value, text } = body || {};
  if (!id || !type) {
    res.status(400).json({ error: 'Missing type or id' });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  if (type === 'form') {
    const update = {};
    if (value !== undefined) {
      const rating = parseInt(value, 10);
      if (!(rating >= 1 && rating <= 5)) {
        res.status(400).json({ error: 'form rating must be 1-5' });
        return;
      }
      update.form_rating = rating;
    }
    if (typeof text === 'string' && text.trim()) {
      update.form_feedback_text = text.trim().slice(0, 1000);
    }
    if (!Object.keys(update).length) {
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }
    // Rating is set-once (don't let a double-click overwrite the first answer),
    // but the optional free-text comment is a separate, deliberate action (the
    // person clicks "Send" after typing) so it's fine to let it through plainly.
    if (update.form_rating !== undefined) {
      await supabase.from('responses').update(update).eq('id', id).is('form_rating', null);
    } else {
      await supabase.from('responses').update(update).eq('id', id);
    }
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
