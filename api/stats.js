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
  const { data: suggestionRows } = await supabase.from('suggestions').select('response_id');
  const respondedWithMatch = new Set((suggestionRows || []).map((r) => r.response_id));
  const noMatchResponses = Math.max((totalResponses || 0) - respondedWithMatch.size, 0);

  const clickThroughRate = totalShown ? Math.round((totalClicked / totalShown) * 1000) / 10 : null;

  // Pull every response once and do the breakdowns in memory - this table is
  // small enough (pilot scale) that a DB-side aggregation isn't worth the extra
  // round trips, and it lets us build the per-response list from the same data.
  const { data: responses } = await supabase
    .from('responses')
    .select('id, created_at, name, self_vertical, self_department, self_seniority, goal, goal_detail, wanted_org_type, wanted_vertical, wanted_department, wanted_country, free_text, form_rating, form_feedback_text, diagnostic_flags')
    .order('created_at', { ascending: false });

  const { data: feedbackRows } = await supabase.from('suggestions').select('feedback').not('feedback', 'is', null);
  const matchFeedbackUp = (feedbackRows || []).filter((r) => r.feedback === 'up').length;
  const matchFeedbackDown = (feedbackRows || []).filter((r) => r.feedback === 'down').length;

  const formRatings = (responses || []).map((r) => r.form_rating).filter((v) => v != null);
  const avgFormRating = formRatings.length
    ? Math.round((formRatings.reduce((a, b) => a + b, 0) / formRatings.length) * 10) / 10
    : null;

  function countBy(rows, getValue) {
    const counts = {};
    rows.forEach((r) => {
      const v = getValue(r);
      const values = Array.isArray(v) ? v : [v];
      values.forEach((val) => {
        if (!val) return;
        counts[val] = (counts[val] || 0) + 1;
      });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
  }

  const rows = responses || [];
  const goalBreakdown = countBy(rows, (r) => r.goal);
  const wantedVerticalBreakdown = countBy(rows, (r) => r.wanted_vertical);
  const wantedDepartmentBreakdown = countBy(rows, (r) => r.wanted_department);
  const selfVerticalBreakdown = countBy(rows, (r) => r.self_vertical);

  const recentResponses = rows.slice(0, 50).map((r) => ({
    created_at: r.created_at,
    name: r.name,
    self_vertical: r.self_vertical,
    goal: r.goal,
    goal_detail: r.goal_detail,
    wanted_org_type: r.wanted_org_type,
    wanted_vertical: r.wanted_vertical,
    wanted_country: r.wanted_country,
    free_text: r.free_text,
    matched: respondedWithMatch.has(r.id),
  }));

  const diagnosticFlagCounts = {};
  rows.forEach((r) => {
    (r.diagnostic_flags || []).forEach((f) => { diagnosticFlagCounts[f] = (diagnosticFlagCounts[f] || 0) + 1; });
  });

  const formFeedbackComments = rows
    .filter((r) => r.form_feedback_text)
    .map((r) => ({ created_at: r.created_at, rating: r.form_rating, text: r.form_feedback_text }));

  const payload = {
    total_responses: totalResponses || 0,
    suggestions_shown: totalShown || 0,
    suggestions_clicked: totalClicked || 0,
    click_through_rate_pct: clickThroughRate,
    responses_with_no_match: noMatchResponses || 0,
    avg_form_rating: avgFormRating,
    form_ratings_count: formRatings.length,
    match_feedback_up: matchFeedbackUp,
    match_feedback_down: matchFeedbackDown,
    goal_breakdown: goalBreakdown,
    wanted_vertical_breakdown: wantedVerticalBreakdown,
    wanted_department_breakdown: wantedDepartmentBreakdown,
    self_vertical_breakdown: selfVerticalBreakdown,
    recent_responses: recentResponses,
    form_feedback_comments: formFeedbackComments,
    diagnostic_flag_counts: diagnosticFlagCounts,
    generated_at: new Date().toISOString(),
  };

  // ?full_text=1 - every non-empty free_text value (not just the latest 50),
  // for periodic qualitative theme analysis.
  if (req.query && (req.query.full_text === '1' || req.query.full_text === 'true')) {
    payload.all_free_text = rows
      .filter((r) => r.free_text)
      .map((r) => ({ created_at: r.created_at, self_vertical: r.self_vertical, goal: r.goal, free_text: r.free_text }));
  }

  res.status(200).json(payload);
};
