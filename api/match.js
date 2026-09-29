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
  const wantedVerticals = (responseRow.wanted_vertical || [])
    .filter((v) => v && v !== 'No preference')
    .map((v) => VERTICAL_MAP[v] || v);
  const countryDbValues = responseRow.wanted_country ? (COUNTRY_OPTIONS[responseRow.wanted_country] || [responseRow.wanted_country]) : null;

  function buildQuery(includeCountry) {
    let q = supabase.from('pool').select('*');
    if (selfTalentId) q = q.neq('talent_id', selfTalentId);
    if (responseRow.wanted_org_type && responseRow.wanted_org_type !== 'No preference') {
      q = q.eq('org_type', ORG_TYPE_MAP[responseRow.wanted_org_type] || responseRow.wanted_org_type);
    }
    if (responseRow.wanted_scope && responseRow.wanted_scope !== 'No preference') {
      q = q.eq('scope', SCOPE_MAP[responseRow.wanted_scope] || responseRow.wanted_scope);
    }
    if (includeCountry && countryDbValues) {
      q = q.in('country', countryDbValues);
    }
    if (wantedVerticals.length) q = q.in('vertical', wantedVerticals);
    if (responseRow.wanted_seniority && responseRow.wanted_seniority !== 'No preference') {
      q = q.in('seniority', seniorityAtLeast(responseRow.wanted_seniority));
    }
    return q.limit(500);
  }

  let { data: filtered, error: filterErr } = await buildQuery(true);
  if (filterErr) {
    res.status(500).json({ error: 'Filter query failed', detail: filterErr.message });
    return;
  }

  // A country with zero matches should never zero out an otherwise-good result
  // on its own - retry without it and be transparent about the miss.
  let countryFallback = false;
  if ((!filtered || filtered.length === 0) && countryDbValues) {
    const retry = await buildQuery(false);
    if (!retry.error && retry.data && retry.data.length) {
      filtered = retry.data;
      countryFallback = true;
    }
  }

  if (!filtered || filtered.length === 0) {
    res.status(200).json({ matches: [], note: 'No candidates matched the hard filters.' });
    return;
  }

  // Layer 2 (soft) - specific company request. A named company matters more than
  // the country checkbox, so if it doesn't show up in the country-filtered set,
  // look for it again ignoring country (keeping type/scope/vertical/seniority)
  // and fold in anyone found - the explicit "who" beats the geography filter.
  const companyNames = parseCompanyNames(responseRow.wanted_specific_company);
  let pool = filtered;
  if (companyNames.length && countryDbValues && !countryFallback) {
    const filteredIds = new Set(filtered.map((c) => c.talent_id));
    const crossCountry = await buildQuery(false);
    if (!crossCountry.error && crossCountry.data) {
      const extra = crossCountry.data.filter((c) => !filteredIds.has(c.talent_id) && companyMatches(c, companyNames));
      if (extra.length) pool = [...filtered, ...extra];
    }
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

  pool.sort((a, b) => {
    const aCompany = specificMatchIds.has(a.talent_id) ? 0 : 1;
    const bCompany = specificMatchIds.has(b.talent_id) ? 0 : 1;
    if (aCompany !== bCompany) return aCompany - bCompany;

    if (isMentorshipGoal) {
      const aMentor = a.mentor_available ? 0 : 1;
      const bMentor = b.mentor_available ? 0 : 1;
      if (aMentor !== bMentor) return aMentor - bMentor;
    }

    return (suggestionCounts[a.talent_id] || 0) - (suggestionCounts[b.talent_id] || 0);
  });

  const shortlist = pool.slice(0, CANDIDATE_CAP);

  // 3. Layer 5 - LLM ranking + confidence.
  const VERTICAL_LABELS = Object.fromEntries(Object.entries(VERTICAL_MAP).map(([label, code]) => [code, label]));
  const candidateLines = shortlist.map((c) => (
    `id=${c.talent_id} | name=${c.first_name} ${c.last_name} | headline=${c.headline || c.title || ''} | company=${c.company || ''} | vertical=${VERTICAL_LABELS[c.vertical] || c.vertical || ''} | seniority=${c.seniority || 'unknown'} | org_type=${c.org_type || 'unknown'} | scope=${c.scope || 'unknown'}${isMentorshipGoal ? ` | mentor=${c.mentor_available ? 'yes, available' : (c.is_mentor ? 'yes, not currently available' : 'no')}` : ''}`
  )).join('\n');

  const systemPrompt = `You are helping Nova Talent, a professional community, match a member with 1-3 people worth introducing them to.
You will get a requester's stated goal and free-text description, plus a shortlist of candidates who already passed hard filters (organization type, scope, country, vertical, seniority).
Your job: pick the best 1-3 candidates from the shortlist (or fewer if none are a good fit - never invent a candidate not in the list), write a one-sentence reason for each grounded in their actual profile data, and give an honest overall confidence score from 0 to 100 for how well this shortlist satisfies the request.
If the requester named a specific company and no candidate is from that company, say so plainly in the reason for whichever candidate you pick instead (e.g. "not at Google, but a similarly-sized global tech company").
${isMentorshipGoal ? 'The requester is looking for mentorship - candidates marked as an available mentor should be strongly preferred when they otherwise fit, since they have explicitly opted in to mentoring.\n' : ''}Respond with ONLY a JSON object, no markdown fences, no explanation outside the JSON, in this exact shape:
{"picks": [{"talent_id": 12345, "reason": "..."}], "confidence": 0-100}`;

  const userPrompt = `Requester's goal: ${responseRow.goal || 'not specified'}
Requester's specific interest area: ${responseRow.goal_detail || 'none'}
Requester's specific company request: ${responseRow.wanted_specific_company || 'none'}
Requester's department preference (soft signal, not a hard filter): ${responseRow.wanted_department || 'no preference'}
${countryFallback ? `Note: nobody matched the requested country (${responseRow.wanted_country}), so this shortlist ignores that filter - mention this plainly in the reason for whichever candidate you pick.\n` : ''}Requester's free text: "${responseRow.free_text || ''}"

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
