const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.status(500).json({ error: 'Server misconfigured: missing env vars' });
    return;
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { count: totalResponses } = await supabase.from('responses').select('*', { count: 'exact', head: true });
  const { count: totalShown } = await supabase.from('suggestions').select('*', { count: 'exact', head: true }).eq('shown', true);
  const { count: totalClicked } = await supabase.from('suggestions').select('*', { count: 'exact', head: true }).eq('shown', true).not('clicked_at', 'is', null);
  const { data: respondedRows } = await supabase.from('suggestions').select('response_id');
  const respondedWithMatch = new Set((respondedRows || []).map((r) => r.response_id)).size;
  const noMatchResponses = Math.max((totalResponses || 0) - respondedWithMatch, 0);

  const clickThroughRate = totalShown ? Math.round((totalClicked / totalShown) * 1000) / 10 : null;

  res.status(200).json({
    total_responses: totalResponses || 0,
    suggestions_shown: totalShown || 0,
    suggestions_clicked: totalClicked || 0,
    click_through_rate_pct: clickThroughRate,
    responses_with_no_match: noMatchResponses || 0,
    generated_at: new Date().toISOString(),
  });
};
