// =====================================================
// Excel Generator — n8n Code Node
// =====================================================
// Purpose: Takes AI Agent forecast JSON and builds
//          a multi-tab .xlsx workbook
// Tabs:    1.Actuals YTD | 2.Baseline | 3.Upside
//          4.Downside | 5.Budget vs Forecast | 6.Assumptions
// =====================================================

const XLSX = require('xlsx');

// ── 1. Parse AI Agent Output ──
const raw = $input.first().json;
let forecast;
try {
  const rawText = raw.output || raw.text || raw.response || JSON.stringify(raw);
  const match = rawText.match(/```json\n?([\s\S]*?)\n?```/);
  forecast = JSON.parse(match ? match[1] : rawText);
} catch(e) { forecast = raw; }

const {
  property    = 'Portfolio',
  period      = new Date().toISOString().slice(0, 7),
  actuals     = [],
  baseline    = [],
  upside      = [],
  downside    = [],
  variance    = [],
  assumptions = []
} = forecast;

// ── 2. Helpers ──
const cur = v => isNaN(Number(v)) ? (v ?? '') : Math.round(Number(v));

function periodKeys(data) {
  if (!data?.length) return [];
  const skip = ['property','gl_code','gl_account','account_name','category'];
  return Object.keys(data[0]).filter(k => !skip.includes(k.toLowerCase()));
}

// ── 3. Sheet Builders ──

function buildActuals(data) {
  if (!data.length) return XLSX.utils.aoa_to_sheet([['No actuals data. Add file to /yardi-input/']]);
  const periods = periodKeys(data);
  const headers = ['Category', 'GL Code', 'Account Name', ...periods, 'YTD Total'];
  const rows = data.map(r => {
    const ytd = periods.reduce((s, p) => s + (Number(r[p]) || 0), 0);
    return [r.category||'', r.gl_code||r.gl_account||'', r.account_name||'',
            ...periods.map(p => cur(r[p])), cur(ytd)];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [{wch:14},{wch:10},{wch:30},...periods.map(()=>({wch:12})),{wch:14}];
  return ws;
}

function buildForecast(data, label) {
  if (!data.length) return XLSX.utils.aoa_to_sheet([[`No ${label} data. Run a forecast first.`]]);
  const periods = periodKeys(data);
  const title   = [`SCENARIO: ${label.toUpperCase()}`, ...Array(periods.length + 3).fill('')];
  const headers = ['Category', 'GL Code', 'Account Name', ...periods, 'Forecast Total'];
  const rows = data.map(r => {
    const total = periods.reduce((s, p) => s + (Number(r[p]) || 0), 0);
    return [r.category||'', r.gl_code||r.gl_account||'', r.account_name||'',
            ...periods.map(p => cur(r[p])), cur(total)];
  });
  const ws = XLSX.utils.aoa_to_sheet([title, headers, ...rows]);
  ws['!cols'] = [{wch:14},{wch:10},{wch:30},...periods.map(()=>({wch:13})),{wch:15}];
  return ws;
}

function buildVariance(data) {
  if (!data.length) return XLSX.utils.aoa_to_sheet([['No variance data available']]);
  const headers = ['Category','Account Name','Budget (Annual)','YTD Actuals',
                   'Remaining Budget','Baseline Forecast','$ Variance','% Variance','Flag'];
  const rows = data.map(r => {
    const dVar = cur(Number(r.forecast||0) - Number(r.budget||0));
    const pVar = r.budget ? dVar / Math.abs(Number(r.budget)) : 0;
    const flag = Math.abs(pVar) > 0.05 || Math.abs(dVar) > 10000 ? 'WARNING' : '';
    return [r.category||'', r.account_name||'',
            cur(r.budget), cur(r.ytd_actuals),
            cur(Number(r.budget||0) - Number(r.ytd_actuals||0)),
            cur(r.forecast), dVar, `${(pVar*100).toFixed(1)}%`, flag];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [{wch:14},{wch:28},{wch:16},{wch:14},{wch:18},{wch:18},{wch:14},{wch:12},{wch:10}];
  return ws;
}

function buildAssumptions(data) {
  const meta = [
    [`FORECAST ASSUMPTIONS — ${property.toUpperCase()}`],
    [`Period: ${period}`],
    [`Generated: ${new Date().toISOString().split('T')[0]}`],
    ['']
  ];
  const headers = ['Scenario','Category','Assumption','Value / Range','Data Source','Notes'];
  const rows = data.length ? data.map(a => [
    a.scenario||'', a.category||'', a.assumption||'',
    a.value||'', a.source||'', a.notes||''
  ]) : [
    ['Baseline','Rent Growth','CMA median per CMHC/Yardi','Per market-data files','CMHC RMS 2025',''],
    ['Baseline','Vacancy','Current run-rate + seasonal trend','94.5%','Rent roll actuals',''],
    ['Upside','Vacancy','100-150bps tighter vs baseline','96%','Seasonal Q2 uplift',''],
    ['Downside','Rent Growth','Bottom quartile / flat to -1%','0% to -1%','Yardi Canada Q1 2026',''],
  ];
  const ws = XLSX.utils.aoa_to_sheet([...meta, headers, ...rows]);
  ws['!cols'] = [{wch:12},{wch:16},{wch:38},{wch:18},{wch:24},{wch:32}];
  return ws;
}

// ── 4. Build Workbook ──
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, buildActuals(actuals),               '1. Actuals YTD');
XLSX.utils.book_append_sheet(wb, buildForecast(baseline, 'Baseline'), '2. Baseline Forecast');
XLSX.utils.book_append_sheet(wb, buildForecast(upside,   'Upside'),   '3. Upside');
XLSX.utils.book_append_sheet(wb, buildForecast(downside, 'Downside'), '4. Downside');
XLSX.utils.book_append_sheet(wb, buildVariance(variance),             '5. Budget vs Forecast');
XLSX.utils.book_append_sheet(wb, buildAssumptions(assumptions),       '6. Assumptions');

// ── 5. Output ──
const buf      = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const fileName = `${property.replace(/\s+/g,'_')}_Forecast_${period}.xlsx`;

return [{
  json: {
    fileName,
    status: 'success',
    tabs: ['1. Actuals YTD','2. Baseline Forecast','3. Upside',
           '4. Downside','5. Budget vs Forecast','6. Assumptions']
  },
  binary: { data: {
    data: buf.toString('base64'),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName
  }}
}];
