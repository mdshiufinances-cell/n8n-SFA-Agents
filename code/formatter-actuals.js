// =====================================================
// Tool 4 — Read Yardi Files — Final Code Node v3.3
// (Adapted for Tool 6 — hardcoded fileType: actuals)
// =====================================================
// ROOT CAUSE FIX vs v3.2:
//
//   v3.0–v3.2 used parseInt(key) to get column indices.
//   When n8n returns named string keys ("__EMPTY_1",
//   "Jul 2025", etc.) parseInt returns NaN. JavaScript
//   coerces NaN to the string "NaN" as an object key,
//   so all 12 months collapse to a single entry.
//   count still reaches 12 (triggering >=6), but only
//   the LAST month survives — "Jun 2026".
//
//   v3.0 accidentally worked because the extra guard
//   Object.keys(headerColMap).length >= 6 (= 1, fail)
//   dropped through to date arithmetic → 11 actuals.
//
//   v3.2 removed that guard → broken header_label_scan
//   fires → 0 actuals.
//
// FIX: use raw key STRINGS throughout period detection
//   and GL data extraction. No parseInt for column
//   matching. Build all maps keyed on raw key strings.
//   Works for numeric keys ("0","1","2"), named keys
//   ("__EMPTY_1"), and month-name keys ("Jul 2025").
//
// Also includes:
//   - Period-row parser ("Period = Jul 2025-Mar 2026")
//     as primary detection source — most robust method
//   - Three fallback levels retained
//   - 0-actuals safety net → date arithmetic
//   - 40-row token cap from v3.1
//
// TOOL 6 ADAPTATION:
//   - fileType is hardcoded to 'actuals' (this branch only)
//   - propertyCode is read dynamically from the new
//     3-field Tool 6 trigger (lowercase 'propertyCode')
// =====================================================

const items = $input.all();

if (!items || items.length === 0 || !items[0].json || Object.keys(items[0].json).length === 0) {
  const propertyCode = $('When Executed by Another Workflow').first().json.propertyCode;
  const fileType     = 'actuals';
  return [{ json: { output: JSON.stringify({
    success: false,
    message: `No ${fileType} file found for property ${propertyCode}.`
  }) } }];
}

const fileType     = 'actuals';
const propertyCode = $('When Executed by Another Workflow').first().json.propertyCode;
const rows = items.map(item => item.json);

// ── HELPERS ──────────────────────────────────────────────────────────────────
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseMonthLabel(raw) {
  const s = String(raw || '').trim().replace(/-/g, ' ');
  const m = s.match(/^(\w+)\s+(\d{2,4})$/);
  if (!m) return null;
  const mIdx = MONTH_NAMES.findIndex(n => n.toLowerCase() === m[1].toLowerCase().slice(0,3));
  if (mIdx === -1) return null;
  const year = m[2].length === 2 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
  return { label: `${MONTH_NAMES[mIdx]} ${year}`, mIdx, year };
}

function monthEndDate(mIdx, year) { return new Date(year, mIdx + 1, 0); }

function shortKey(label) {
  const p = label.match(/^(\w+)\s+(\d{4})$/);
  return p ? `${p[1].slice(0,3)}-${String(p[2]).slice(2)}` : label;
}

// Sort key entries: numeric first (parseInt), then string fallback.
// Never used for column-index lookups — only for ordered iteration.
function sortedEntries(obj) {
  return Object.entries(obj).sort(([a], [b]) => {
    const na = parseInt(a), nb = parseInt(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
}

// ── STEP 1: Find the month-name row ──────────────────────────────────────────
// Key STRINGS are stored directly — no parseInt. This is the core fix.
// Whether the key is "2", "__EMPTY_1", or "Jul 2025", each column gets
// its own unique entry in headerKeyMap.
let headerRowIdx = -1;
const headerKeyMap = {}; // rawKey → {label, mIdx, year}

for (let i = 0; i < Math.min(rows.length, 15); i++) {
  const found = {};
  let count = 0;
  for (const [key, val] of Object.entries(rows[i])) {
    const parsed = parseMonthLabel(val);
    if (parsed) { found[key] = parsed; count++; } // raw key, not parseInt
  }
  if (count >= 6) {
    Object.assign(headerKeyMap, found);
    headerRowIdx = i;
    break;
  }
}

// ── STEP 2: Find the Actual/Budget label row ──────────────────────────────────
// Same raw-key approach. Looks in the 3 rows above the month-name row.
const ACTUAL_RE = /^actual$/i;
const BUDGET_RE = /^budget$/i;
const actualBudgetKeyMap = {}; // rawKey → 'actual' | 'budget'

if (headerRowIdx > 0) {
  for (let i = Math.max(0, headerRowIdx - 3); i < headerRowIdx; i++) {
    let actualCount = 0, budgetCount = 0;
    const map = {};
    for (const [key, val] of Object.entries(rows[i])) {
      const s = String(val || '').trim();
      if (ACTUAL_RE.test(s)) { map[key] = 'actual'; actualCount++; }
      else if (BUDGET_RE.test(s)) { map[key] = 'budget'; budgetCount++; }
    }
    if (actualCount >= 3 && budgetCount >= 1) {
      Object.assign(actualBudgetKeyMap, map);
      break;
    }
  }
}

// ── STEP 3: Parse the "Period = " row ────────────────────────────────────────
// Yardi always writes "Period = Jul 2025-Mar 2026" in the report header.
// This explicitly states the last closed actual month — the most reliable
// period boundary regardless of key format or export timing.
let periodActualsEnd = null;

for (const row of rows.slice(0, 15)) {
  for (const val of Object.values(row)) {
    const s = String(val || '').trim();
    const m = s.match(/Period\s*=\s*[A-Za-z]+\s+\d{4}\s*[-–]\s*([A-Za-z]+\s+\d{4})/i);
    if (m) { periodActualsEnd = parseMonthLabel(m[1].trim()); break; }
  }
  if (periodActualsEnd) break;
}

// ── STEP 4: Classify months ───────────────────────────────────────────────────
const today = new Date();
let actualsMonths  = [];
let forecastMonths = [];
let actualsKeySet  = new Set(); // raw keys of actual-month columns
let forecastKeySet = new Set(); // raw keys of forecast-month columns
let detectionMethod;

const hasHeaderMap = Object.keys(headerKeyMap).length >= 6;
const hasABMap     = Object.keys(actualBudgetKeyMap).length >= 3;
const hasPeriodRow = !!periodActualsEnd;

if (hasHeaderMap && hasPeriodRow) {
  // ✅ Method 0 — Period-row scan (most reliable)
  // Uses "Period = [start]-[end]" text to determine the last actual month.
  // Works regardless of key format or export date.
  detectionMethod = 'period_row_scan';
  for (const [key, info] of sortedEntries(headerKeyMap)) {
    const isActual = (info.year < periodActualsEnd.year) ||
                     (info.year === periodActualsEnd.year && info.mIdx <= periodActualsEnd.mIdx);
    if (isActual) { actualsMonths.push(info.label); actualsKeySet.add(key); }
    else          { forecastMonths.push(info.label); forecastKeySet.add(key); }
  }

} else if (hasHeaderMap && hasABMap) {
  // ✅ Method 1 — Actual/Budget label row (raw-key matching)
  // Reads Yardi's own "Actual / Budget" column labels.
  detectionMethod = 'header_label_scan';
  for (const [key, info] of sortedEntries(headerKeyMap)) {
    if (actualBudgetKeyMap[key] === 'actual') {
      actualsMonths.push(info.label); actualsKeySet.add(key);
    } else {
      forecastMonths.push(info.label); forecastKeySet.add(key);
    }
  }

} else if (hasHeaderMap) {
  // ⚠️ Method 2 — Date comparison (header row found, no label row)
  detectionMethod = 'header_date_scan';
  for (const [key, info] of sortedEntries(headerKeyMap)) {
    const end = monthEndDate(info.mIdx, info.year);
    if (end < today) { actualsMonths.push(info.label); actualsKeySet.add(key); }
    else             { forecastMonths.push(info.label); forecastKeySet.add(key); }
  }
}

// ⚠️ Safety net / Method 3 — Date arithmetic
// Fires when no header found OR any method above returns 0 actuals.
if (!hasHeaderMap || actualsMonths.length === 0) {
  detectionMethod = actualsMonths.length === 0 && hasHeaderMap
    ? 'date_arithmetic_fallback_safety'
    : 'date_arithmetic_fallback';
  actualsMonths = []; forecastMonths = []; actualsKeySet = new Set(); forecastKeySet = new Set();
  const fyStartMonth = 6;
  const fyStartYear  = today.getMonth() >= 6 ? today.getFullYear() : today.getFullYear() - 1;
  for (let m = 0; m < 12; m++) {
    const mIdx  = (fyStartMonth + m) % 12;
    const mYear = fyStartYear + Math.floor((fyStartMonth + m) / 12);
    const label = `${MONTH_NAMES[mIdx]} ${mYear}`;
    const end   = monthEndDate(mIdx, mYear);
    if (end < today) actualsMonths.push(label);
    else             forecastMonths.push(label);
  }
}

const trailingAvgMonths = actualsMonths.slice(-3);

// ── STEP 5: Build key→shortMonthLabel map for GL data extraction ──────────────
// Built directly from scanning VALUES in the month-name row.
// No parseInt involved — works for any key format.
const keyToMonthLabel = {}; // rawKey → "Jul-25"

if (headerRowIdx >= 0) {
  for (const [key, val] of Object.entries(rows[headerRowIdx])) {
    const parsed = parseMonthLabel(val);
    if (parsed) keyToMonthLabel[key] = shortKey(parsed.label);
  }
}

// Build keyPositionMap from the WIDEST row (most keys) rather than the
// header row. Header/label rows often omit columns A/B (GL Code, Account
// Name) when those cells are blank, which shifts every subsequent column
// position left by 2 and corrupts GL Code / Account Name / Original Budget
// extraction. A fully-populated GL data row always has all columns present,
// so it gives the correct column order.
let widestRow = rows[0] || {};
for (const r of rows) {
  if (Object.keys(r).length > Object.keys(widestRow).length) widestRow = r;
}
const keyPositionMap = {}; // rawKey → 0-based column position
Object.keys(widestRow).forEach((k, i) => { keyPositionMap[k] = i; });

// ── STEP 6: Filter GL data rows ───────────────────────────────────────────────
const GL_REGEX = /^\d{4,6}$/;
const dataRows = rows.filter(row => {
  const first = String(Object.values(row)[0] || '').trim();
  return GL_REGEX.test(first);
});

const KEY_GL = new Set([
  '40000','41000','41100','41110','41200','41990',
  '42000','42100','42210','42990',
  '43100','43290','43510','44990','45990',
  '60000','60500','69990','75000','75990',
  '80000','87990','89000','89190','89200','89290',
  '89300','89390','90000','90010','99000','99150',
  '99200','99250','99350','99995'
]);

let outputRows;
if (['actuals','budget','actuals_py','budget_py'].includes(fileType)) {
  const filtered = dataRows.filter(row => {
    const gl = String(Object.values(row)[0] || '').trim();
    return KEY_GL.has(gl) || gl.endsWith('990') || gl.endsWith('000')
      || gl.endsWith('010') || gl.endsWith('200');
  });
  outputRows = filtered.length > 0 ? filtered : dataRows.slice(0, 80);
} else {
  outputRows = dataRows.slice(0, 300);
}

// ── STEP 7: Build named GL rows ───────────────────────────────────────────────
// Uses keyToMonthLabel (value-scanned) and keyPositionMap (position-based)
// so no column index assumptions are made.
let namedRows = outputRows.map(row => {
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    const pos = keyPositionMap[key];

    // GL Code: position 0 in the column reference order
    if (pos === 0) { out['gl_code'] = val; continue; }
    // Account Name: position 1
    if (pos === 1) { out['account_name'] = val; continue; }

    // Monthly value: key appears in month-name row with a month label
    const mk = keyToMonthLabel[key];
    if (mk) {
      out[mk] = typeof val === 'number' ? val : (parseFloat(val) || 0);
      continue;
    }

    // Original Budget: position 15 (col P in Yardi standard layout)
    if (pos === 15) {
      out['original_budget'] = typeof val === 'number' ? val : (parseFloat(val) || 0);
    }
  }
  return out;
});

// ── ROW CAP ───────────────────────────────────────────────────────────────────
// Raised from 40 to 200 vs the original Tool 4 design. The 40-row cap
// existed to protect the LLM agent's context window when this data was
// passed through Tool 4 directly to the agent. In the Tool 6 architecture,
// this data is consumed entirely inside Tool 6 and never enters the LLM
// context, so the original token-conservation rationale no longer applies.
// A typical Yardi P&L has ~100-130 GL lines; 200 leaves headroom.
namedRows = namedRows.slice(0, 200);

// ── RETURN ────────────────────────────────────────────────────────────────────
return [{ json: { output: JSON.stringify({
  success:          true,
  fileType,
  propertyCode,
  detectionMethod,
  actualsMonths,
  forecastMonths,
  trailingAvgMonths,
  actualsCount:     actualsMonths.length,
  forecastCount:    forecastMonths.length,
  rowCount:         namedRows.length,
  data:             namedRows,
  _debug: {
    keyFormat:      Object.keys(rows[0] || {}).slice(0,4),
    headerRowIdx,
    headerMapSize:  Object.keys(headerKeyMap).length,
    abMapSize:      Object.keys(actualBudgetKeyMap).length,
    periodRowFound: hasPeriodRow,
    periodEnd:      periodActualsEnd ? periodActualsEnd.label : null
  }
}) } }];
