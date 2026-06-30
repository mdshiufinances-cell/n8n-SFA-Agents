// =====================================================
// Tool 6 — Compute Financials v4 — n8n Code Node
// =====================================================
// This node sits AFTER a Merge node that collects
// outputs from 4 Google Drive file-reading branches.
// Each branch tags its output with a fileType field.
// This node reads from $input.all() directly —
// no data passed through the LLM.
//
// v4 CHANGE vs v3: Key Findings totals (ytdRevenue,
// ytdOpEx, ytdNOI, budget variance, YOY) now use anchor
// "TOTAL" GL codes (45990 / 90000 / 90010) instead of
// summing every row tagged with a category. The actuals
// array contains BOTH leaf GL lines (e.g. 41100 Rent
// Revenue) AND their parent subtotal/grand-total rows
// (e.g. 41990 Total Rent Revenue, 45990 TOTAL REVENUES).
// Summing by category double/triple-counted the same
// dollars. Falls back to the old sum-by-category method
// only if the anchor GL row isn't present in the data
// (e.g. an unusual chart of accounts), and flags this
// in dataQuality.warningFlags so it's visible to the user.
// =====================================================

// ── READ TRIGGER PARAMS ──────────────────────────────
const trigger     = $('When Executed by Another Workflow').first().json;
const propertyCode = trigger.propertyCode || 'prop01';
const period       = trigger.period       || '2026-Q3';
const fiscalYear   = trigger.fiscalYear   || 'FY2026';

// ── COLLECT FILE DATA FROM MERGED BRANCHES ───────────
const allItems = $input.all();

let actualsResult   = null;
let pyResult        = null;
let budgetResult    = null;
let rentRollResult  = null;

for (const item of allItems) {
  const ft  = item.json.fileType || '';
  const raw = item.json.output;
  if (!raw) continue;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed.success) continue;
    if (ft === 'actuals')    actualsResult  = parsed;
    if (ft === 'actuals_py') pyResult       = parsed;
    if (ft === 'budget')     budgetResult   = parsed;
    if (ft === 'rent_roll')  rentRollResult = parsed;
  } catch(e) { continue; }
}

if (!actualsResult) {
  return [{ json: { output: JSON.stringify({
    success: false,
    message: `Tool 6 error: actuals file not found or failed to parse for ${propertyCode}. Check Google Drive /yardi-input/ for ${propertyCode}_actuals.xlsx`
  }) } }];
}

const actualsData       = actualsResult.data            || [];
const actualsMonths     = actualsResult.actualsMonths   || [];
const trailingAvgMonths = actualsResult.trailingAvgMonths || [];
const forecastMonths    = actualsResult.forecastMonths  || [];
const pyActualsData     = pyResult       ? (pyResult.data       || []) : [];
const budgetData        = budgetResult   ? (budgetResult.data   || []) : [];
const rentRollData      = rentRollResult ? (rentRollResult.data || []) : [];

// ── HELPERS ──────────────────────────────────────────
function toShortKey(label) {
  const m = String(label || '').match(/^(\w{3})\w*\s+(\d{4})$/);
  if (!m) return label;
  return `${m[1]}-${String(m[2]).slice(2)}`;
}
const actualsKeys  = actualsMonths.map(toShortKey);
const trailingKeys = trailingAvgMonths.map(toShortKey);
const forecastKeys = forecastMonths.map(toShortKey);

function num(v) { return typeof v === 'number' ? v : (parseFloat(v) || 0); }
function avg(vals) {
  const ns = vals.filter(v => v !== null && v !== undefined).map(num);
  return ns.length ? ns.reduce((a,b) => a+b, 0) / ns.length : 0;
}
function round2(v) { return Math.round(v * 100) / 100; }
function findRow(arr, gl) { return arr.find(r => r.gl_code === gl); }

// ── GL CATEGORY ──────────────────────────────────────
const GL_CATEGORY = {
  '41100':'Revenue','41110':'Revenue','41200':'Revenue',
  '41990':'Revenue','42100':'Revenue','42210':'Revenue',
  '42990':'Revenue','43100':'Revenue','43290':'Revenue',
  '43510':'Revenue','44990':'Revenue','45990':'Revenue',
  '69990':'Labor',  '75990':'Admin',  '87990':'R&M',
  '89190':'Utilities','89290':'Realty Tax','89390':'Mgmt Fee',
};
function getCategory(gl) {
  if (GL_CATEGORY[gl]) return GL_CATEGORY[gl];
  const n = parseInt(gl);
  if (n >= 41000 && n < 60000) return 'Revenue';
  if (n >= 60000 && n < 76000) return 'Labor';
  if (n >= 76000 && n < 88000) return 'Admin';
  if (n >= 88000 && n < 89200) return 'R&M';
  if (n >= 89200 && n < 89300) return 'Utilities';
  if (n >= 89300 && n < 89400) return 'Realty Tax';
  if (n >= 89400 && n < 90000) return 'Mgmt Fee';
  return 'Other';
}

// ── SCENARIO ADJUSTMENTS ─────────────────────────────
const SCENARIO_ADJ = {
  '41100':[ 0.000,  0.005,-0.010],
  '41110':[-0.100, -0.270, 0.270],
  '41200':[ 0.000, -0.300, 0.300],
  '42100':[ 0.000,  0.030,-0.030],
  '42210':[ 0.000,  0.050,-0.050],
  '43100':[ 0.000,  0.020,-0.020],
  '43510':[ 0.000,  0.020,-0.020],
  '69990':[ 0.000, -0.030, 0.050],
  '75990':[ 0.000, -0.020, 0.040],
  '87990':[ 0.000, -0.050, 0.080],
  '89190':[-0.100, -0.150,-0.050],
  '89290':[ 0.000,  0.000, 0.000],
  '89390':[ 0.000,  0.000, 0.000],
};
const SCENARIO_BASIS = {
  '41100':['Flat (0%) — Canadian MF softening; trailing avg',
           '+0.5% — Q2 seasonal uplift; strong occupancy',
           '-1.0% — Downside rent pressure'],
  '41110':['-10% — Modest vacancy improvement',
           '-27% — Tighter vacancy (96%+ occupancy)',
           '+27% — Vacancy deterioration risk'],
  '41200':['0% — Free rent held flat','–30% — Concessions reduce','+30% — Concessions increase'],
  '89190':['-10% — Seasonal utility reduction Q3','-15% — Stronger seasonal reduction','-5% — Minimal seasonal benefit'],
};
const SCENARIO_LABELS = ['Baseline','Upside','Downside'];

// ── BUILD ACTUALS ─────────────────────────────────────
const actuals = [];
for (const row of actualsData) {
  const gl = String(row.gl_code || '').trim();
  if (!gl || !/^\d{4,6}$/.test(gl)) continue;
  const entry = {
    gl_code: gl, account_name: row.account_name || '',
    category: getCategory(gl), ytd_total: 0,
    original_budget: num(row.original_budget),
  };
  let ytd = 0;
  for (const k of actualsKeys) { const v = num(row[k]); entry[k] = v; ytd += v; }
  entry.ytd_total = round2(ytd);
  actuals.push(entry);
}

// ── TRAILING AVERAGES ────────────────────────────────
const trailingAvgMap = {};
for (const row of actuals) {
  trailingAvgMap[row.gl_code] = avg(trailingKeys.map(k => num(row[k])));
}

// ── SCENARIOS ────────────────────────────────────────
function buildScenario(idx) {
  return actuals.map(row => {
    const gl  = row.gl_code;
    const adj = SCENARIO_ADJ[gl] ? SCENARIO_ADJ[gl][idx] : 0;
    const val = round2((trailingAvgMap[gl] || 0) * (1 + adj));
    const entry = {
      gl_code: gl, account_name: row.account_name, category: row.category,
      adj_pct: adj,
      basis: (SCENARIO_BASIS[gl] && SCENARIO_BASIS[gl][idx])
             || `${SCENARIO_LABELS[idx]} — ${(adj*100).toFixed(1)}% on trailing avg`,
    };
    let total = 0;
    for (const fk of forecastKeys) { entry[fk] = val; total += val; }
    entry.forecast_total = round2(total);
    return entry;
  });
}
const baseline = buildScenario(0);
const upside   = buildScenario(1);
const downside = buildScenario(2);

// ── VARIANCE ─────────────────────────────────────────
const variance = actuals.map(row => {
  const budgetAnnual = num(row.original_budget);
  const ytdActuals   = num(row.ytd_total);
  const bRow         = baseline.find(b => b.gl_code === row.gl_code);
  const fcQ3         = bRow ? num(bRow.forecast_total) : 0;
  const totalFc      = round2(ytdActuals + fcQ3);
  const varDollar    = round2(totalFc - budgetAnnual);
  const varPct       = budgetAnnual !== 0 ? round2(varDollar / Math.abs(budgetAnnual)) : 0;
  const flag         = Math.abs(varPct) > 0.05 || Math.abs(varDollar) > 10000
                       ? (varDollar > 0 ? 'FAV' : 'UNFAV') : 'NEUTRAL';
  return { gl_code: row.gl_code, account_name: row.account_name, category: row.category,
           budget_annual: budgetAnnual, ytd_actuals: ytdActuals,
           forecast_q3_baseline: fcQ3, total_forecast: totalFc,
           var_dollar: varDollar, var_pct: varPct, flag };
});

// ── ASSUMPTIONS ──────────────────────────────────────
const assumptions = [];
for (const row of actuals) {
  for (let s = 0; s < 3; s++) {
    const gl = row.gl_code;
    const adj = SCENARIO_ADJ[gl] ? SCENARIO_ADJ[gl][s] : 0;
    assumptions.push({
      gl_code: gl, account_name: row.account_name, category: row.category,
      scenario: SCENARIO_LABELS[s], adj_pct: adj,
      basis: (SCENARIO_BASIS[gl] && SCENARIO_BASIS[gl][s])
             || `${SCENARIO_LABELS[s]} — ${(adj*100).toFixed(1)}% adj on trailing avg`,
      source: 'Yardi actuals + CMHC RMS 2025 Toronto',
    });
  }
}

// ── PRIOR-YEAR ────────────────────────────────────────
const pyActuals = [];
for (const pyRow of pyActualsData) {
  const gl = String(pyRow.gl_code || '').trim();
  if (!gl || !/^\d{4,6}$/.test(gl)) continue;
  const fy2025Total = num(pyRow.original_budget) || (() => {
    let s = 0;
    for (const [k,v] of Object.entries(pyRow)) {
      if (!['gl_code','account_name','original_budget'].includes(k)) s += num(v);
    }
    return s;
  })();
  const cyRow     = variance.find(v => v.gl_code === gl);
  const cyTotal   = cyRow ? num(cyRow.total_forecast) : 0;
  const yoyDollar = round2(cyTotal - fy2025Total);
  pyActuals.push({
    gl_code: gl, account_name: pyRow.account_name || '', category: getCategory(gl),
    fy2025_total: round2(fy2025Total), yoy_dollar: yoyDollar,
    yoy_pct: fy2025Total !== 0 ? round2(yoyDollar / Math.abs(fy2025Total)) : null,
  });
}

// ── RENT ROLL ─────────────────────────────────────────
let rentRoll = null;
if (rentRollData.length) {
  let totalUnits = rentRollData.length, occupiedUnits = 0;
  let marketRentTotal = 0, inPlaceRentTotal = 0;
  for (const row of rentRollData) {
    const status = String(row.unit_status || row.status || 'occ').toLowerCase();
    if (status.includes('occ')) occupiedUnits++;
    marketRentTotal  += num(row.market_rent  || row.market  || 0);
    inPlaceRentTotal += num(row.in_place_rent || row.actual_rent || row.charge || 0);
  }
  const lossToLease = round2(marketRentTotal - inPlaceRentTotal);
  rentRoll = {
    asOfDate: new Date().toISOString().split('T')[0],
    totalUnits, occupiedUnits, vacantUnits: totalUnits - occupiedUnits,
    occupancyRate: round2(occupiedUnits / totalUnits),
    portfolioMarketRent: round2(marketRentTotal),
    portfolioInPlaceRent: round2(inPlaceRentTotal),
    lossToLease,
    lossToLeasePct: marketRentTotal ? round2(lossToLease / marketRentTotal) : null,
  };
}

// ── KEY FINDINGS ─────────────────────────────────────
// Use anchor "TOTAL" GL codes to avoid double-counting leaf + subtotal +
// grand-total rows that all share category === 'Revenue' (or non-Revenue).
const TOTAL_REVENUE_GL = '45990';   // TOTAL REVENUES
const TOTAL_OPEX_GL    = '90000';   // TOTAL OPERATING EXPENSES
const warningFlagsExtra = [];

const revAnchor  = findRow(actuals, TOTAL_REVENUE_GL);
const opexAnchor = findRow(actuals, TOTAL_OPEX_GL);

let ytdRevenue, ytdOpEx;
if (revAnchor && opexAnchor) {
  ytdRevenue = round2(num(revAnchor.ytd_total));
  ytdOpEx    = round2(Math.abs(num(opexAnchor.ytd_total)));
} else {
  warningFlagsExtra.push(`Anchor GL ${TOTAL_REVENUE_GL}/${TOTAL_OPEX_GL} not found in actuals — Key Findings totals estimated by summing category rows, which may double-count subtotals.`);
  const revRows = actuals.filter(r => r.category === 'Revenue');
  const expRows = actuals.filter(r => r.category !== 'Revenue');
  ytdRevenue = round2(revRows.reduce((s,r) => s + num(r.ytd_total), 0));
  ytdOpEx    = round2(expRows.reduce((s,r) => s + Math.abs(num(r.ytd_total)), 0));
}
const ytdNOI = round2(ytdRevenue - ytdOpEx);

const revBaseline  = baseline.find(b => b.gl_code === TOTAL_REVENUE_GL);
const opexBaseline = baseline.find(b => b.gl_code === TOTAL_OPEX_GL);

let fyRevBL, fyOpExBL;
if (revAnchor && revBaseline) {
  fyRevBL = round2(num(revAnchor.ytd_total) + num(revBaseline.forecast_total));
} else {
  const revRows = actuals.filter(r => r.category === 'Revenue');
  fyRevBL = round2(revRows.reduce((s,r) => {
    const b = baseline.find(b => b.gl_code === r.gl_code);
    return s + num(r.ytd_total) + (b ? num(b.forecast_total) : 0);
  }, 0));
}
if (opexAnchor && opexBaseline) {
  fyOpExBL = round2(Math.abs(num(opexAnchor.ytd_total)) + Math.abs(num(opexBaseline.forecast_total)));
} else {
  const expRows = actuals.filter(r => r.category !== 'Revenue');
  fyOpExBL = round2(expRows.reduce((s,r) => {
    const b = baseline.find(b => b.gl_code === r.gl_code);
    return s + Math.abs(num(r.ytd_total)) + Math.abs(b ? num(b.forecast_total) : 0);
  }, 0));
}
const fyNOIBL = round2(fyRevBL - fyOpExBL);

const budgetRevTotal = revAnchor
  ? num(revAnchor.original_budget)
  : actuals.filter(r => r.category === 'Revenue').reduce((s,r) => s + num(r.original_budget), 0);
const budgetVarDollar = round2(fyRevBL - budgetRevTotal);
const budgetVarPct    = budgetRevTotal ? round2(budgetVarDollar / Math.abs(budgetRevTotal)) : null;

const pyRevAnchor = pyActuals.find(r => r.gl_code === TOTAL_REVENUE_GL);
const pyRevTotal  = pyRevAnchor
  ? num(pyRevAnchor.fy2025_total)
  : pyActuals.filter(r => r.category === 'Revenue').reduce((s,r) => s + num(r.fy2025_total), 0);
const yoyRevDollar = pyRevTotal ? round2(fyRevBL - pyRevTotal) : null;
const yoyRevPct    = pyRevTotal ? round2(yoyRevDollar / Math.abs(pyRevTotal)) : null;

// Exclude subtotal/grand-total rows from the "top variance" rankings so
// they don't crowd out genuine line-item variances with inflated subtotal
// dollar amounts. A row is treated as a subtotal if its account_name
// starts with 2 spaces of indent or fewer (leaf items are indented 4+).
function isLeafRow(r) {
  const raw = (r.account_name || '');
  const indent = raw.length - raw.trimStart().length;
  return indent >= 4;
}
const leafVariance = variance.filter(r => isLeafRow(r));
const sortedLeafVar = [...leafVariance].sort((a,b) => Math.abs(b.var_dollar) - Math.abs(a.var_dollar));
const topFav   = sortedLeafVar.filter(r => r.flag==='FAV').slice(0,3)
  .map(r => ({gl:r.gl_code,account:r.account_name,var_dollar:r.var_dollar,var_pct:r.var_pct}));
const topUnfav = sortedLeafVar.filter(r => r.flag==='UNFAV').slice(0,3)
  .map(r => ({gl:r.gl_code,account:r.account_name,var_dollar:r.var_dollar,var_pct:r.var_pct}));

// ── WARNING FLAGS ─────────────────────────────────────
const warningFlags = [...warningFlagsExtra];
if (!pyActualsData.length)    warningFlags.push('PY actuals not found — YOY section will be blank');
if (!rentRollData.length)     warningFlags.push('Rent roll not found — occupancy section uses estimates');
if (!budgetData.length)       warningFlags.push('Budget file not found — variance section will be blank');
if (actualsMonths.length < 9) warningFlags.push(`Only ${actualsMonths.length} months of actuals available`);

// ── ASSEMBLE ──────────────────────────────────────────
const forecastData = {
  property: propertyCode, period, fiscalYear,
  generatedAt: new Date().toISOString(),
  dataQuality: {
    hasPriorYearActuals: pyActuals.length > 0,
    hasPriorYearBudget: false, hasPriorYearRentRoll: false,
    actualsMonthsAvailable: actualsMonths.length,
    warningFlags,
  },
  actuals, baseline, upside, downside, variance, assumptions, pyActuals, rentRoll,
  keyFindings: {
    ytdRevenue, ytdOpEx, ytdNOI,
    ytdNOIMargin: ytdRevenue ? round2(ytdNOI/ytdRevenue) : null,
    fullYearRevenueBaseline: fyRevBL,
    fullYearOpExBaseline: fyOpExBL,
    fullYearNOIBaseline: fyNOIBL,
    budgetVarianceDollar: budgetVarDollar,
    budgetVariancePct: budgetVarPct,
    yoyRevenueDollar: yoyRevDollar,
    yoyRevenuePct: yoyRevPct,
    topFavourableVariances: topFav,
    topUnfavourableVariances: topUnfav,
  },
};

return [{ json: { output: JSON.stringify(forecastData) } }];
