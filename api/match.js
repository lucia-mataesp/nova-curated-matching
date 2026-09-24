const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5';
const CONFIDENCE_THRESHOLD = 50; // 0-100. Below this, we don't force a suggestion.
const CANDIDATE_CAP = 25; // how many survivors we actually send to the LLM
const ANTI_SATURATION_WINDOW_DAYS = 30;

const SENIORITY_ORDER = [
  'Intern',
  'Employee / Analyst',
  'Manager / Team Lead',
  'Senior Manager / Director',
  'C-Level / Executive',
  'Founder / Owner',
];

// The pool stores Nova's raw internal codes/formats, which differ from the
// friendly labels shown on the form. Map form -> pool value before querying.
const VERTICAL_MAP = {
  'CEO / Entrepreneurship': 'CEO_ENTREPRENEURS',
  'Data Science': 'DATA_SCIENCE',
  'Engineering': 'ENGINEERS',
  'Finance & Accounting': 'FINANCE_AND_ACCOUNTING',
  'Human Resources': 'HUMAN_RESOURCES',
  'Investment (PE/VC)': 'INVESTMENTS_PE_AND_VC',
  'Legal': 'LEGAL_SERVICES',
  'Life Sciences / Healthcare': 'LIFE_SCIENCES_AND_PSYCHOLOGY_AND_HEALTHCARE',
  'Marketing': 'MARKETING',
  'Operations': 'OPERATIONS',
  'Product': 'PRODUCT',
  'Sales & Business Development': 'SALES_AND_BUSINESS_DEVELOPMENT',
  'Software Development': 'SOFTWARE_DEVELOPMENT',
  'Strategy': 'STRATEGY',
  'Other': 'OTHER',
};

const ORG_TYPE_MAP = {
  'Company / Corporation': 'Company/Corporation',
  'Law firm': 'Law firm', // no candidates classified this way yet - known gap
  'Consulting firm': 'Consulting firm',
  'Bank / Financial institution': 'Bank/Financial institution', // same known gap
  'Investment fund (PE/VC)': 'Investment fund (PE/VC)',
  'Startup / Scaleup': 'Startup/Scaleup',
  'Public sector / Academia / NGO': 'Public sector/Academia/NGO',
  'Freelance / Own business': 'Freelance/Own business',
};

const SCOPE_MAP = {
  'Global / Multinational': 'Global/Multinational',
  'International (mid-size)': 'International mid-size',
  'Large / mid-size local': 'Large/mid-size local',
  'Small local': 'Small local',
};

// The pool's country column was enriched in Spanish. The form asks for country
// as free text in English, so translate common names before matching; fall back
// to whatever the requester typed if it's not in this list (covers the case
// where they already typed the Spanish name, or a country we haven't seen yet).
const COUNTRY_MAP = {
  spain: 'España', sweden: 'Suecia', 'united kingdom': 'Reino Unido', uk: 'Reino Unido',
  'united states': 'Estados Unidos', usa: 'Estados Unidos', us: 'Estados Unidos',
  italy: 'Italia', france: 'Francia', denmark: 'Dinamarca', germany: 'Alemania',
  switzerland: 'Suiza', norway: 'Noruega', 'united arab emirates': 'Emiratos Árabes Unidos',
  uae: 'Emiratos Árabes Unidos', netherlands: 'Países Bajos', belgium: 'Bélgica',
  ireland: 'Irlanda', luxembourg: 'Luxemburgo', mexico: 'México', australia: 'Australia',
  singapore: 'Singapur', austria: 'Austria', canada: 'Canadá', portugal: 'Portugal',
  india: 'India', finland: 'Finlandia', china: 'China',
};

function mapCountry(input) {
  if (!input) return input;
  const key = input.trim().toLowerCase();
  return COUNTRY_MAP[key] || input;
}

const ROLE_FIELD_REFS = [
  'a_rol_ceo', 'a_rol_datascience', 'a_rol_engineers', 'a_rol_finance', 'a_rol_hr',
  'a_rol_investments', 'a_rol_legal', 'a_rol_lifesciences', 'a_rol_marketing',
  'a_rol_operations', 'a_rol_product', 'a_rol_sales', 'a_rol_software',
  'a_rol_strategy', 'a_rol_otro',
];

function seniorityAtLeast(minLabel) {
  const idx = SENIORITY_ORDER.indexOf(minLabel);
  if (idx === -1) return SENIORITY_ORDER; // unknown -> no restriction
  return SENIORITY_ORDER.slice(idx);
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey || !anthropicKey) {
    res.status(500).json({ error: 'Server misconfigured: missing env vars' });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  let answers;
  try {
    answers = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  const selfRoleRef = ROLE_FIELD_REFS.find((ref) => answers[ref]);

  // 1. Log the response (raw_answers is the safety net for anything not modeled below).
  const responseRow = {
    name: answers.a_nombre || null,
    email: answers.a_email || null,
    self_org_type: answers.a_tipo_org || null,
    self_scope: answers.a_alcance || null,
    self_country: answers.a_pais || null,
    self_city: answers.a_ciudad || null,
    self_vertical: answers.a_vertical || null,
    self_role: selfRoleRef ? answers[selfRoleRef] : null,
    self_department: answers.a_departamento || null,
    self_seniority: answers.a_seniority || null,
    wanted_org_type: answers.b_tipo_org || null,
    wanted_scope: answers.b_alcance || null,
    wanted_country: answers.b_pais || null,
    wanted_specific_company: answers.b_empresa_concreta || null,
    wanted_vertical: Array.isArray(answers.b_vertical) ? answers.b_vertical : (answers.b_vertical ? [answers.b_vertical] : null),
    wanted_department: answers.b_departamento || null,
    wanted_seniority: answers.b_seniority || null,
    goal: answers.b_objetivo || null,
    goal_detail: answers.b_mentoria_area || answers.b_socio_sector || null,
    free_text: answers.b_texto_libre || null,
    consent: !!answers.consentimiento,
    raw_answers: answers,
  };

  // Try to find the requester's own pool row (so we can exclude self-matches).
  let selfTalentId = null;
  if (responseRow.email) {
    const { data: selfRows } = await supabase
      .from('pool')
      .select('talent_id')
      .ilike('email', responseRow.email)
      .limit(1);
    if (selfRows && selfRows.length) selfTalentId = selfRows[0].talent_id;
  }
  responseRow.pool_talent_id = selfTalentId;

  const { data: insertedResponse, error: insertErr } = await supabase
    .from('responses')
    .insert(responseRow)
    .select('id')
    .single();

  if (insertErr) {
    res.status(500).json({ error: 'Could not save response', detail: insertErr.message });
    return;
  }
  const responseId = insertedResponse.id;

  // 2. Layer 1 - hard categorical filter.
  let query = supabase.from('pool').select('*');

  if (selfTalentId) query = query.neq('talent_id', selfTalentId);

  if (responseRow.wanted_org_type && responseRow.wanted_org_type !== 'No preference') {
    query = query.eq('org_type', ORG_TYPE_MAP[responseRow.wanted_org_type] || responseRow.wanted_org_type);
  }
  if (responseRow.wanted_scope && responseRow.wanted_scope !== 'No preference') {
    query = query.eq('scope', SCOPE_MAP[responseRow.wanted_scope] || responseRow.wanted_scope);
  }
  if (responseRow.wanted_country) {
    query = query.ilike('country', mapCountry(responseRow.wanted_country));
  }
  const wantedVerticals = (responseRow.wanted_vertical || [])
    .filter((v) => v && v !== 'No preference')
    .map((v) => VERTICAL_MAP[v] || v);
  if (wantedVerticals.length) {
    query = query.in('vertical', wantedVerticals);
  }
  if (responseRow.wanted_seniority && responseRow.wanted_seniority !== 'No preference') {
    query = query.in('seniority', seniorityAtLeast(responseRow.wanted_seniority));
  }

  const { data: filtered, error: filterErr } = await query.limit(500);
  if (filterErr) {
    res.status(500).json({ error: 'Filter query failed', detail: filterErr.message });
    return;
  }

  if (!filtered || filtered.length === 0) {
    res.status(200).json({ matches: [], note: 'No candidates matched the hard filters.' });
    return;
  }

  // Layer 2 (soft) - specific company boost, never a hard filter.
  const specificCompany = (responseRow.wanted_specific_company || '').trim().toLowerCase();
  let pool = filtered;
  if (specificCompany) {
    const exactMatches = filtered.filter((c) =>
      (c.company || '').toLowerCase().includes(specificCompany) ||
      (c.company_matched || '').toLowerCase().includes(specificCompany)
    );
    const rest = filtered.filter((c) => !exactMatches.includes(c));
    pool = [...exactMatches, ...rest];
  }

  // Layer 4 - anti-saturation: deprioritize people suggested a lot recently.
  const sinceDate = new Date(Date.now() - ANTI_SATURATION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const talentIds = pool.map((c) => c.talent_id);
  const { data: recentSuggestions } = await supabase
    .from('suggestions')
    .select('talent_id')
    .in('talent_id', talentIds)
    .gte('created_at', sinceDate);

  const suggestionCounts = {};
  (recentSuggestions || []).forEach((s) => {
    suggestionCounts[s.talent_id] = (suggestionCounts[s.talent_id] || 0) + 1;
  });

  const withSpecificMatch = specificCompany
    ? pool.filter((c) => (c.company || '').toLowerCase().includes(specificCompany) || (c.company_matched || '').toLowerCase().includes(specificCompany))
    : [];
  const specificMatchIds = new Set(withSpecificMatch.map((c) => c.talent_id));

  pool.sort((a, b) => {
    const aBoost = specificMatchIds.has(a.talent_id) ? 0 : 1;
    const bBoost = specificMatchIds.has(b.talent_id) ? 0 : 1;
    if (aBoost !== bBoost) return aBoost - bBoost;
    return (suggestionCounts[a.talent_id] || 0) - (suggestionCounts[b.talent_id] || 0);
  });

  const shortlist = pool.slice(0, CANDIDATE_CAP);

  // 3. Layer 5 - LLM ranking + confidence.
  const VERTICAL_LABELS = Object.fromEntries(Object.entries(VERTICAL_MAP).map(([label, code]) => [code, label]));
  const candidateLines = shortlist.map((c) => (
    `id=${c.talent_id} | name=${c.first_name} ${c.last_name} | headline=${c.headline || c.title || ''} | company=${c.company || ''} | vertical=${VERTICAL_LABELS[c.vertical] || c.vertical || ''} | seniority=${c.seniority || 'unknown'} | org_type=${c.org_type || 'unknown'} | scope=${c.scope || 'unknown'}`
  )).join('\n');

  const systemPrompt = `You are helping Nova Talent, a professional community, match a member with 1-3 people worth introducing them to.
You will get a requester's stated goal and free-text description, plus a shortlist of candidates who already passed hard filters (organization type, scope, country, vertical, seniority).
Your job: pick the best 1-3 candidates from the shortlist (or fewer if none are a good fit - never invent a candidate not in the list), write a one-sentence reason for each grounded in their actual profile data, and give an honest overall confidence score from 0 to 100 for how well this shortlist satisfies the request.
If the requester named a specific company and no candidate is from that company, say so plainly in the reason for whichever candidate you pick instead (e.g. "not at Google, but a similarly-sized global tech company").
Respond with ONLY a JSON object, no markdown fences, no explanation outside the JSON, in this exact shape:
{"picks": [{"talent_id": 12345, "reason": "..."}], "confidence": 0-100}`;

  const userPrompt = `Requester's goal: ${responseRow.goal || 'not specified'}
Requester's specific interest area: ${responseRow.goal_detail || 'none'}
Requester's specific company request: ${responseRow.wanted_specific_company || 'none'}
Requester's department preference (soft signal, not a hard filter): ${responseRow.wanted_department || 'no preference'}
Requester's free text: "${responseRow.free_text || ''}"

Candidate shortlist:
${candidateLines}`;

  let llmResult;
  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const textBlock = message.content.find((b) => b.type === 'text');
    llmResult = textBlock ? extractJson(textBlock.text) : null;
  } catch (e) {
    res.status(500).json({ error: 'LLM call failed', detail: e.message });
    return;
  }

  if (!llmResult || !Array.isArray(llmResult.picks)) {
    res.status(200).json({ matches: [], note: 'Could not parse a valid shortlist from the model.' });
    return;
  }

  const confidence = typeof llmResult.confidence === 'number' ? llmResult.confidence : 0;
  const belowThreshold = confidence < CONFIDENCE_THRESHOLD;
  const picks = belowThreshold ? [] : llmResult.picks.slice(0, 3);

  // 4. Persist suggestions (even below-threshold attempts, marked shown=false, for later review).
  const candidateById = Object.fromEntries(shortlist.map((c) => [c.talent_id, c]));
  const suggestionRows = llmResult.picks.slice(0, 3).map((p, i) => ({
    response_id: responseId,
    talent_id: p.talent_id,
    rank: i + 1,
    reason: p.reason,
    confidence_score: confidence,
    model: MODEL,
    shown: !belowThreshold,
  }));
  if (suggestionRows.length) {
    await supabase.from('suggestions').insert(suggestionRows);
  }

  const matches = picks
    .map((p) => {
      const c = candidateById[p.talent_id];
      if (!c) return null;
      return {
        name: `${c.first_name} ${c.last_name}`,
        headline: c.headline || c.title || '',
        reason: p.reason,
        connect_url: `https://app.novatalent.com/members/${c.public_id}`,
      };
    })
    .filter(Boolean);

  res.status(200).json({
    matches,
    confidence,
    note: belowThreshold ? "We don't have a strong match yet - we'll keep looking and follow up." : null,
  });
};
