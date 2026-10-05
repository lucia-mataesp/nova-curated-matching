const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5';
const CONFIDENCE_THRESHOLD = 50; // 0-100. Below this, we don't force a suggestion.
const CANDIDATE_CAP = 25; // how many survivors we actually send to the LLM
const ANTI_SATURATION_WINDOW_DAYS = 30;
const ACTIVITY_WINDOW_DAYS = 30;

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
  'Law firm': 'Law firm',
  'Consulting firm': 'Consulting firm',
  'Bank / Financial institution': 'Bank/Financial institution',
  'Investment fund (PE/VC)': 'Investment fund (PE/VC)',
  'Startup / Scaleup': 'Startup/Scaleup',
  'Public sector / Academia / NGO': 'Public sector/Academia/NGO',
  'Freelance / Own business': 'Freelance/Own business',
};

// Friendly, user-facing phrasing for why a given hard filter was relaxed -
// used to tell people something true and specific instead of a vague
// "not fully confident" disclaimer.
const RELAXATION_FRIENDLY = {
  'country': "there aren't many people from that country in the community yet",
  'scope (included people with unverified scope)': "we don't have company size/scope confirmed for everyone in that space yet",
  'seniority': 'we had to widen beyond the exact seniority level you asked for',
  'scope': 'we had to widen beyond the exact company size/scope you asked for',
  'organization type': 'we had to widen beyond the exact organization type you asked for',
  'vertical': 'we had to widen beyond the exact industry/vertical you asked for',
};

const SCOPE_MAP = {
  'Global / Multinational': 'Global/Multinational',
  'International (mid-size)': 'International mid-size',
  'Large / mid-size local': 'Large/mid-size local',
  'Small local': 'Small local',
};

// Country is now a dropdown on the form (English label), but the pool's country
// column was enriched in Spanish - map the English label to every raw spelling
// that appears in the data (the enrichment produced a couple of duplicate
// spellings for the same country, e.g. Qatar/Catar).
const COUNTRY_OPTIONS = {
  'Andorra': ['Andorra'], 'Argentina': ['Argentina'], 'Australia': ['Australia'],
  'Austria': ['Austria'], 'Bahamas': ['Bahamas'], 'Belgium': ['Bélgica'],
  'Brazil': ['Brasil'], 'Bulgaria': ['Bulgaria'], 'Burundi': ['Burundi'],
  'Canada': ['Canadá'], 'Chile': ['Chile'], 'China': ['China'],
  'Colombia': ['Colombia'], "Côte d'Ivoire": ['Costa de Marfil'], 'Croatia': ['Croacia'],
  'Cyprus': ['Chipre'], 'Czech Republic': ['República Checa', 'Chequia'],
  'Democratic Republic of the Congo': ['República Democrática del Congo'],
  'Denmark': ['Dinamarca'], 'Dominican Republic': ['República Dominicana'],
  'Ecuador': ['Ecuador'], 'Egypt': ['Egipto'], 'Estonia': ['Estonia'],
  'Ethiopia': ['Etiopía'], 'Finland': ['Finlandia'], 'France': ['Francia'],
  'Germany': ['Alemania'], 'Ghana': ['Ghana'], 'Gibraltar': ['Gibraltar'],
  'Greece': ['Grecia'], 'Guatemala': ['Guatemala'], 'Guinea-Bissau': ['Guinea-Bisáu'],
  'Hong Kong': ['Hong Kong'], 'Hungary': ['Hungría'], 'India': ['India'],
  'Ireland': ['Irlanda'], 'Israel': ['Israel'], 'Italy': ['Italia'],
  'Japan': ['Japón'], 'Jordan': ['Jordania'], 'Kenya': ['Kenia'],
  'Lithuania': ['Lituania'], 'Luxembourg': ['Luxemburgo'], 'Malaysia': ['Malasia'],
  'Malta': ['Malta'], 'Mexico': ['México'], 'Monaco': ['Mónaco'],
  'Morocco': ['Marruecos'], 'Netherlands': ['Países Bajos'], 'New Zealand': ['Nueva Zelanda'],
  'Nigeria': ['Nigeria'], 'Norway': ['Noruega'], 'Pakistan': ['Pakistán'],
  'Palestine': ['Palestina'], 'Panama': ['Panamá'], 'Peru': ['Perú'],
  'Philippines': ['Filipinas'], 'Poland': ['Polonia'], 'Portugal': ['Portugal'],
  'Qatar': ['Catar', 'Qatar'], 'Romania': ['Rumanía', 'Rumania'],
  'Saudi Arabia': ['Arabia Saudita'], 'Senegal': ['Senegal'], 'Serbia': ['Serbia'],
  'Singapore': ['Singapur'], 'Slovenia': ['Eslovenia'], 'South Africa': ['Sudáfrica'],
  'South Korea': ['Corea del Sur'], 'Spain': ['España'], 'Sweden': ['Suecia'],
  'Switzerland': ['Suiza'], 'Taiwan': ['Taiwán'], 'Thailand': ['Tailandia'],
  'Turkey': ['Turquía'], 'Uganda': ['Uganda'], 'Ukraine': ['Ucrania'],
  'United Arab Emirates': ['Emiratos Árabes Unidos'], 'United Kingdom': ['Reino Unido'],
  'United States': ['Estados Unidos'], 'Vietnam': ['Vietnam'], 'Zambia': ['Zambia'],
};

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

// Splits only on a comma or a standalone " or " - NOT on "&", "/" or "and",
// which show up inside real company names ("H&M", "AT&T", "Procter and Gamble").
// A missed multi-company case here is far cheaper than mangling a real one,
// since this only ever feeds a soft boost, never a hard filter.
function parseCompanyNames(raw) {
  if (!raw) return [];
  return raw
    .split(/,|\bor\b/i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function companyMatches(candidate, companyNames) {
  const fields = [(candidate.company || '').toLowerCase(), (candidate.company_matched || '').toLowerCase()];
  return companyNames.some((name) => fields.some((f) => f.includes(name)));
}

// Strict email validation doubles as SQL-injection defense here: a string that
// can't contain a quote or statement separator and still matches this pattern
// is safe to inline into the Metabase query text below.
function isValidEmail(email) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email || '');
}

// If someone filling the form isn't already in our base pool, check whether
// they're a real, accepted Nova member (same bar as the base pool itself) and,
// if so, add them using their own Section A answers - so the pool grows with
// every response instead of staying frozen at the one-time base extract.
async function lookupAndAddSelfToPool(supabase, email, answers) {
  const metabaseKey = process.env.METABASE_API_KEY;
  if (!metabaseKey || !isValidEmail(email)) return null;

  const safeEmail = email.replace(/'/g, "''");
  const sql = `
    SELECT t.id AS talent_id, t.public_id, nt.last_connection
    FROM raw.talent t
    JOIN raw.user u ON u.id = t.user_id
    JOIN raw.application a ON a.talent_id = t.id AND a.accepted_at IS NOT NULL
    JOIN raw.nova_talent nt ON nt.talent_id = t.id
    WHERE lower(u.email) = lower('${safeEmail}')
    LIMIT 1
  `;

  let rows;
  try {
    const mbRes = await fetch('https://metabase.novatalent.com/api/dataset', {
      method: 'POST',
      headers: { 'x-api-key': metabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ database: 2, type: 'native', native: { query: sql } }),
    });
    const mbJson = await mbRes.json();
    rows = mbJson && mbJson.data && mbJson.data.rows;
  } catch (e) {
    return null; // best-effort - never block the main matching flow on this
  }
  if (!rows || !rows.length) return null;

  const [talentId, publicId, lastConnection] = rows[0];
  if (!publicId) return null;

  const countryDb = answers.a_pais ? (COUNTRY_OPTIONS[answers.a_pais] || [answers.a_pais])[0] : null;
  const poolRow = {
    talent_id: talentId,
    public_id: publicId,
    email,
    first_name: (answers.a_nombre || '').split(' ')[0] || null,
    last_name: (answers.a_nombre || '').split(' ').slice(1).join(' ') || null,
    country: countryDb,
    org_type: ORG_TYPE_MAP[answers.a_tipo_org] || null,
    scope: SCOPE_MAP[answers.a_alcance] || null,
    vertical: VERTICAL_MAP[answers.a_vertical] || null,
    seniority: answers.a_seniority || null,
    last_connection: lastConnection || null,
  };
  const { error } = await supabase.from('pool').upsert(poolRow, { onConflict: 'talent_id' });
  if (error) return null;
  return talentId;
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
  if (!selfTalentId && responseRow.email) {
    selfTalentId = await lookupAndAddSelfToPool(supabase, responseRow.email, answers);
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

  // 2. Layer 1 - hard categorical filter, with a cascading relaxation when the
  // full combination matches nobody. Only one constraint is ever dropped at a
  // time (accumulating), in order from "safest to relax" to "most central to
  // the ask" - country first, vertical only as an absolute last resort.
  const wantedVerticals = (responseRow.wanted_vertical || [])
    .filter((v) => v && v !== 'No preference')
    .map((v) => VERTICAL_MAP[v] || v);
  const countryDbValues = responseRow.wanted_country ? (COUNTRY_OPTIONS[responseRow.wanted_country] || [responseRow.wanted_country]) : null;
  const scopeValue = (responseRow.wanted_scope && responseRow.wanted_scope !== 'No preference')
    ? (SCOPE_MAP[responseRow.wanted_scope] || responseRow.wanted_scope)
    : null;

  function buildQuery(state) {
    let q = supabase.from('pool').select('*');
    if (selfTalentId) q = q.neq('talent_id', selfTalentId);
    if (!state.dropOrgType && responseRow.wanted_org_type && responseRow.wanted_org_type !== 'No preference') {
      q = q.eq('org_type', ORG_TYPE_MAP[responseRow.wanted_org_type] || responseRow.wanted_org_type);
    }
    if (!state.dropScope && scopeValue) {
      q = state.scopeIncludeUnknown ? q.or(`scope.eq.${scopeValue},scope.is.null`) : q.eq('scope', scopeValue);
    }
    if (!state.dropCountry && countryDbValues) {
      q = q.in('country', countryDbValues);
    }
    if (!state.dropVertical && wantedVerticals.length) {
      q = state.verticalMode === 'past'
        ? q.overlaps('past_verticals', wantedVerticals)
        : q.in('vertical', wantedVerticals);
    }
    if (!state.dropSeniority && responseRow.wanted_seniority && responseRow.wanted_seniority !== 'No preference') {
      q = q.in('seniority', seniorityAtLeast(responseRow.wanted_seniority));
    }
    return q.limit(500);
  }

  // Each step keeps every relaxation from the steps before it (cumulative).
  const RELAXATION_STEPS = [
    { label: null },
    { label: 'country', dropCountry: true },
    { label: 'scope (included people with unverified scope)', dropCountry: true, scopeIncludeUnknown: true },
    { label: 'seniority', dropCountry: true, scopeIncludeUnknown: true, dropSeniority: true },
    { label: 'scope', dropCountry: true, dropScope: true, dropSeniority: true },
    { label: 'organization type', dropCountry: true, dropScope: true, dropSeniority: true, dropOrgType: true },
    { label: 'vertical', dropCountry: true, dropScope: true, dropSeniority: true, dropOrgType: true, dropVertical: true },
  ];

  let filtered = null;
  let appliedState = RELAXATION_STEPS[0];
  const relaxedLabels = [];
  for (const step of RELAXATION_STEPS) {
    const { data, error } = await buildQuery(step);
    if (error) {
      res.status(500).json({ error: 'Filter query failed', detail: error.message });
      return;
    }
    if (step.label) relaxedLabels.push(step.label);
    if (data && data.length) {
      filtered = data;
      appliedState = step;
      break;
    }
  }

  if (!filtered) {
    res.status(200).json({ matches: [], note: 'No candidates matched the hard filters, even after relaxing most of them.', response_id: responseId });
    return;
  }

  const relaxationNote = appliedState.label
    ? `Relaxed: ${relaxedLabels.slice(0, relaxedLabels.indexOf(appliedState.label) + 1).join(', ')}`
    : null;
  const countryFallback = !!appliedState.dropCountry;

  // Layer 2 (soft) - specific company request. A named company matters more than
  // the country checkbox, so if it doesn't show up in the filtered set, look for
  // it again ignoring country (keeping type/scope/vertical/seniority as applied)
  // and fold in anyone found - the explicit "who" beats the geography filter.
  const companyNames = parseCompanyNames(responseRow.wanted_specific_company);
  let pool = filtered;
  if (companyNames.length && countryDbValues && !countryFallback) {
    const filteredIds = new Set(filtered.map((c) => c.talent_id));
    const crossCountry = await buildQuery({ ...appliedState, dropCountry: true });
    if (!crossCountry.error && crossCountry.data) {
      const extra = crossCountry.data.filter((c) => !filteredIds.has(c.talent_id) && companyMatches(c, companyNames));
      if (extra.length) pool = [...filtered, ...extra];
    }
  }

  // Layer 2b (soft) - vertical via past experience, not just current role.
  // Someone whose CURRENT role isn't a requested vertical, but who genuinely
  // has history in one (e.g. was a CHRO before moving into a different role),
  // is folded in too - tagged so Layer 5 can tell current-role matches from
  // background-only matches apart, and must say so explicitly when it picks one.
  if (wantedVerticals.length && !appliedState.dropVertical) {
    const poolIds = new Set(pool.map((c) => c.talent_id));
    const { data: pastData } = await buildQuery({ ...appliedState, verticalMode: 'past' });
    const extra = (pastData || []).filter((c) => !poolIds.has(c.talent_id) && !wantedVerticals.includes(c.vertical));
    if (extra.length) pool = [...pool, ...extra.map((c) => ({ ...c, _viaPastVertical: true }))];
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

  const specificMatchIds = new Set(
    companyNames.length ? pool.filter((c) => companyMatches(c, companyNames)).map((c) => c.talent_id) : []
  );
  const isMentorshipGoal = responseRow.goal === 'Looking for mentorship / advice';
  const activitySince = Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const isRecentlyActive = (c) => c.last_connection && new Date(c.last_connection).getTime() >= activitySince;

  pool.sort((a, b) => {
    const aCompany = specificMatchIds.has(a.talent_id) ? 0 : 1;
    const bCompany = specificMatchIds.has(b.talent_id) ? 0 : 1;
    if (aCompany !== bCompany) return aCompany - bCompany;

    if (isMentorshipGoal) {
      const aMentor = a.mentor_available ? 0 : 1;
      const bMentor = b.mentor_available ? 0 : 1;
      if (aMentor !== bMentor) return aMentor - bMentor;
    }

    // A current-role vertical match is a safer bet than one found only through
    // past experience - prefer it, without excluding the background match.
    const aPast = a._viaPastVertical ? 1 : 0;
    const bPast = b._viaPastVertical ? 1 : 0;
    if (aPast !== bPast) return aPast - bPast;

    // Among otherwise-similar candidates, someone active in the last 30 days
    // is a better bet than someone who may not even check Nova Connect anymore.
    const aActive = isRecentlyActive(a) ? 0 : 1;
    const bActive = isRecentlyActive(b) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;

    return (suggestionCounts[a.talent_id] || 0) - (suggestionCounts[b.talent_id] || 0);
  });

  const shortlist = pool.slice(0, CANDIDATE_CAP);

  // 3. Layer 5 - LLM ranking + confidence.
  const VERTICAL_LABELS = Object.fromEntries(Object.entries(VERTICAL_MAP).map(([label, code]) => [code, label]));
  const candidateLines = shortlist.map((c) => {
    let pastNote = '';
    if (c._viaPastVertical && c.past_vertical_detail) {
      const matchedCode = wantedVerticals.find((v) => (c.past_verticals || []).includes(v));
      const detail = matchedCode && c.past_vertical_detail[matchedCode];
      if (detail) {
        pastNote = ` | PAST EXPERIENCE (not current role): ${VERTICAL_LABELS[matchedCode] || matchedCode} - ${detail}`;
      }
    }
    return `id=${c.talent_id} | name=${c.first_name} ${c.last_name} | headline=${c.headline || c.title || ''} | company=${c.company || ''} | vertical=${VERTICAL_LABELS[c.vertical] || c.vertical || ''} | seniority=${c.seniority || 'unknown'} | org_type=${c.org_type || 'unknown'} | scope=${c.scope || 'unknown'}${isMentorshipGoal ? ` | mentor=${c.mentor_available ? 'yes, available' : (c.is_mentor ? 'yes, not currently available' : 'no')}` : ''}${pastNote}`;
  }).join('\n');

  const systemPrompt = `You are helping Nova Talent, a professional community, match a member with 1-3 people worth introducing them to.
You will get a requester's stated goal and free-text description, plus a shortlist of candidates who already passed hard filters (organization type, scope, country, vertical, seniority).
Your job: pick the best 1-3 candidates from the shortlist (or fewer if none are a good fit - never invent a candidate not in the list), write a one-sentence reason for each grounded in their actual profile data, and give an honest overall confidence score from 0 to 100 for how well this shortlist satisfies the request.
If the requester named a specific company and no candidate is from that company, say so plainly in the reason for whichever candidate you pick instead (e.g. "not at Google, but a similarly-sized global tech company").
Some candidates are marked "PAST EXPERIENCE (not current role)" - their CURRENT job isn't in the requested vertical, but they have real history in it. If you pick one of these, you must say so explicitly and naturally in the reason (e.g. "though now an Operations lead, spent 2 years as CHRO at X") - never imply it's their current role when it isn't.
${isMentorshipGoal ? 'The requester is looking for mentorship - candidates marked as an available mentor should be strongly preferred when they otherwise fit, since they have explicitly opted in to mentoring.\n' : ''}Respond with ONLY a JSON object, no markdown fences, no explanation outside the JSON, in this exact shape:
{"picks": [{"talent_id": 12345, "reason": "..."}], "confidence": 0-100}`;

  const wantedOrgTypeDetail = answers.b_tipo_org_detail || null;

  const userPrompt = `Requester's goal: ${responseRow.goal || 'not specified'}
Requester's specific interest area: ${responseRow.goal_detail || 'none'}
Requester's specific company request: ${responseRow.wanted_specific_company || 'none'}
Requester's department preference (soft signal, not a hard filter): ${responseRow.wanted_department || 'no preference'}
${wantedOrgTypeDetail ? `Requester's sub-preference within Public sector/Academia/NGO (soft signal - pool data doesn't track this distinction, so use it only as a tiebreaker when a candidate's headline/company clearly indicates it): ${wantedOrgTypeDetail}\n` : ''}${relaxationNote ? `Note: the strict filters matched nobody, so this shortlist comes from a relaxed search (${relaxationNote}) - mention plainly in the reason for whichever candidate you pick which of their requested criteria this person doesn't actually meet.\n` : ''}Requester's free text: "${responseRow.free_text || ''}"

Candidate shortlist:
${candidateLines}`;

  // The model is asked for strict JSON and almost always complies, but on the
  // rare malformed response, retry once before giving up - a parsing hiccup is
  // not the same thing as "no good candidates", and silently treating it as one
  // would show a false "no match" when the model may have picked someone fine.
  async function callLLM() {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const textBlock = message.content.find((b) => b.type === 'text');
    return textBlock ? extractJson(textBlock.text) : null;
  }

  let llmResult;
  try {
    llmResult = await callLLM();
    if (!llmResult || !Array.isArray(llmResult.picks)) {
      llmResult = await callLLM();
    }
  } catch (e) {
    res.status(500).json({ error: 'LLM call failed', detail: e.message });
    return;
  }

  if (!llmResult || !Array.isArray(llmResult.picks)) {
    res.status(200).json({ matches: [], note: 'Could not parse a valid shortlist from the model.', response_id: responseId });
    return;
  }

  const confidence = typeof llmResult.confidence === 'number' ? llmResult.confidence : 0;
  const lowConfidence = confidence < CONFIDENCE_THRESHOLD;
  // Always show the best picks the model found - never force a result it didn't
  // actually propose, but don't silently withhold a modest-but-real one either.
  // Low confidence is communicated, not hidden.
  const picks = llmResult.picks.slice(0, 3);

  // Give a specific, true reason for low confidence instead of a vague disclaimer -
  // derived from what we actually know happened (which filter got relaxed, whether
  // the named company was found, how thin the candidate pool was), never guessed.
  let confidenceReason = null;
  if (lowConfidence) {
    const pickedNamedCompany = companyNames.length && picks.some((p) => specificMatchIds.has(p.talent_id));
    if (companyNames.length && !pickedNamedCompany) {
      confidenceReason = `we couldn't find anyone currently at ${responseRow.wanted_specific_company} in the community`;
    } else if (appliedState.label) {
      confidenceReason = RELAXATION_FRIENDLY[appliedState.label] || 'we had to broaden the search to find real candidates';
    } else if (shortlist.length < 5) {
      confidenceReason = "there aren't many people matching this exact combination in the community yet";
    } else {
      confidenceReason = "the fit isn't as strong as we'd like on paper";
    }
  }

  // Diagnostic flags - cheap, structured signals for patterns worth watching
  // over time (e.g. "the LLM keeps rejecting candidates for this reason"),
  // separate from the user-facing confidence reason. Not used in the live
  // response at all - purely for the periodic insight-monitoring routine.
  const diagnosticFlags = [];
  if (picks.length === 0 && wantedVerticals.length > 1) {
    const coveredVerticals = new Set(shortlist.map((c) => c.vertical));
    const missingVerticals = wantedVerticals.filter((v) => !coveredVerticals.has(v));
    if (missingVerticals.length) {
      diagnosticFlags.push('vertical_coverage_gap');
    }
  }
  if (diagnosticFlags.length) {
    await supabase.from('responses').update({ diagnostic_flags: diagnosticFlags }).eq('id', responseId);
  }

  // 4. Persist suggestions for later review and for anti-saturation counting.
  const candidateById = Object.fromEntries(shortlist.map((c) => [c.talent_id, c]));
  const suggestionRows = picks.map((p, i) => ({
    response_id: responseId,
    talent_id: p.talent_id,
    rank: i + 1,
    reason: p.reason,
    confidence_score: confidence,
    model: MODEL,
    shown: true,
  }));
  let insertedSuggestions = [];
  if (suggestionRows.length) {
    const { data } = await supabase.from('suggestions').insert(suggestionRows).select('id, talent_id');
    insertedSuggestions = data || [];
  }
  const suggestionIdByTalentId = Object.fromEntries(insertedSuggestions.map((s) => [s.talent_id, s.id]));

  const matches = picks
    .map((p) => {
      const c = candidateById[p.talent_id];
      if (!c) return null;
      return {
        suggestion_id: suggestionIdByTalentId[p.talent_id] || null,
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
    lowConfidence,
    response_id: responseId,
    note: matches.length === 0
      ? 'Could not find anyone worth suggesting from the shortlist.'
      : (lowConfidence ? `These are the best people we found, though ${confidenceReason} - take the reasons with a grain of salt.` : null),
  });
};
