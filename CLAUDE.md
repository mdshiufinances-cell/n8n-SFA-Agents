# n8n-SFA-Agents — Forecasting Agent

## Project Overview

AI-powered quarterly forecasting agent for a Canadian multifamily real estate
portfolio using n8n. The agent reads Yardi Voyager exports from Google Drive,
incorporates prior-year actuals for YOY trending, generates 3-scenario forecasts
(Baseline, Upside, Downside), and populates a 5-tab Excel template (Forecast,
Overrides, Assumptions, Key Findings, _PY_Data).

## Tech Stack

- **Orchestration:** n8n (self-hosted on Hostinger VPS — n8n v2.28.3)
- **LLM:** Anthropic Claude claude-sonnet-4-6 (via n8n Anthropic node)
- **Data source:** Yardi Voyager exports — Google Drive (OAuth2)
- **Market data:** CMHC Rental Market Survey + Yardi Canada MF Reports
- **Output:** Excel (.xlsx) via SheetJS, populating a stored template from Google Drive
- **Environment vars (set in Hostinger Docker Manager YAML — all required):**
  - `NODE_FUNCTION_ALLOW_EXTERNAL=xlsx,exceljs`
  - `NODE_PATH=/usr/local/lib/node_modules/n8n-extra/node_modules`
  - `N8N_DEFAULT_BINARY_DATA_MODE=default` ← **critical** — without this, Code nodes cannot read binary files (template download) because the task runner subprocess only receives filesystem references, not actual bytes

## Portfolio

Properties: TO (prop01), TP (prop02), LP (prop03), BP (prop04),
44B (prop05), 118B (prop06), 99D (prop07) — Canadian multifamily residential

Fiscal year: July 1 – June 30. Functional currency: CAD.

## ⚠️ Major Architecture Pivot (v3) — Read This First

The original design used **three separate agent-callable tools**: Tool 4 (Read
Yardi Files) → agent passes data → Tool 6 (Compute Financials) → agent passes
JSON → Tool 5 (Generate Excel). This failed in production, twice, for the same
root cause:

> **LLM agents cannot reliably relay large data blobs through tool-call
> arguments.** Once a JSON payload reaches tens of KB, the agent either drops
> the parameter entirely or truncates it, regardless of how explicit the tool
> description is.

This broke first when the agent tried to pass raw Tool 4 file outputs into
Tool 6, and again when it tried to pass Tool 6's `forecastData` output into
Tool 5. Both times the fix was the same: **stop making the agent relay data
between tools.**

**Current architecture: Tool 6 does everything internally, in one execution.**
The agent calls Tool 6 with only three small strings (`propertyCode`, `period`,
`fiscalYear`). Tool 6 reads its own files from Google Drive, computes the full
forecast, populates the Excel template, uploads it to Drive, and returns a
small summary object (`fileName`, `driveLink`, `keyFindings`) — never the raw
forecast data.

**Tool 4 and Tool 5 as standalone agent-callable tools are deprecated** for
the forecasting workflow. Tool 4's sub-workflow still exists and can be used
for ad-hoc one-off file lookups outside of forecasting, but the agent's system
prompt explicitly tells it not to call Tool 4 or a separate "Generate Excel"
tool when producing a forecast.

See `docs/tool6-architecture.md` for the full internal node-by-node design.

## Key Design Decisions

- Data source: Google Drive (not local VPS folder — original plan superseded)
- Two entry points: Chat Agent (always-on) + Forecast Workflow (deferred — chat-driven forecasting covers the use case)
- **Excel output: template-population, not from-scratch generation.** A real,
  fully-designed workbook (scenario dropdowns, GL-keyed Overrides lookup
  formulas, conditional formatting, `_PY_Data` wiring) is stored once in
  Google Drive as the template. Tool 6 downloads it fresh each run and writes
  only data values into the correct cells, found by scanning column A for
  each GL code — never assumes fixed row numbers.
- **Template location:** `yardi-output/Excel Template/Quarterly_Forecast_Template.xlsx`
  — stored in Google Drive, downloaded by Tool 6 on every run. To update the
  template, replace this file in Drive; no code changes needed.
- **Period auto-derivation:** `compute-financials-v4.js` derives `period` and
  `fiscalYear` from the actual Yardi file's header dates (via `forecastMonths[0]`),
  overriding whatever the agent guessed. This prevents agent date-confusion from
  producing wrong labels (e.g. "2025-Q3" when the correct answer is "2026-Q4").
- Override logic: GL Code keyed (COUNTIFS/SUMIFS) — NOT row-position dependent
- Prior-year data: FY2025 actuals/budget/rent roll in Google Drive (`_py` suffix files)
- forecastData schema: v2-equivalent internal object — includes `pyActuals[]`,
  `rentRoll{}`, `keyFindings{}`, `dataQuality{}` — but this object now **stays
  inside Tool 6's execution** and is never passed back through the agent.
- **Key Findings totals use anchor GL codes, not category summation.** See
  "Critical Bugs Fixed" below.

## Current Phase (v3.1 — Period Auto-Derivation + Binary Mode Fix)

**Tool 6 (Compute Financials + Generate Excel) — ✅ Production v4.1**
- Single sub-workflow, single agent-facing tool
- Internally: 4 parallel Google Drive read branches (actuals, actuals_py,
  budget, rent_roll) + 1 template download branch → Merge → Compute Financials v4
  → Merge1 → Generate Excel Workbook (dynamic) → Google Drive Upload → Format Output
- Trigger schema: `propertyCode`, `period`, `fiscalYear` (3 strings; period/FY are overridden internally)
- Returns: `fileName`, `driveLink`, `tabs`, `keyFindings` — small summary only
- See `docs/tool6-architecture.md` for full node-by-node design

**Key code files:**
- `code/compute-financials-v4.js` — reads all 4 file branches, computes
  3-scenario forecastData, auto-derives period/fiscalYear from file headers
- `code/generate-excel-workbook-dynamic.js` — populates the template dynamically;
  handles any quarter (Q1 through Q4); reads template binary from `$input.all()`
  (not `$('Download Template').first().binary` — see "Binary Data Mode" note below)
- `code/format-output-final.js` — final node, returns small summary only

**Tool 4 (Read Yardi Files) — ✅ Still production, but NOT used in forecasting**
- Retained as a standalone agent tool only for ad-hoc one-off file lookups

**Tool 5 (Generate Excel) — ❌ Removed as a standalone agent tool**
- Logic now lives inside Tool 6

System Prompt — **✅ v6** (see `docs/system-prompt.md`)
- Injects `{{ $now.format('YYYY-MM-DD') }}` at the top — evaluated by n8n at
  runtime so Bessie always knows today's actual date (prevents LLM date hallucinations)
- 2-step workflow: call Tool 6 → respond
- Calculator explicitly disallowed — Tool 6 handles all arithmetic
- Expected iterations: 2–3

## Critical Bugs Fixed (v3 + v3.1)

**1. GL Code / Account Name column misalignment**
`keyPositionMap` was built from the Yardi file's month-label header row, which
is missing the GL Code and Account Name keys (those cells are blank on header
rows, so n8n drops the keys). This shifted every column left by 2, causing
dollar values to be miscast as GL codes. **Fix:** build `keyPositionMap` from
the *widest* data row (most keys) instead of the header row.

**2. Key Findings double/triple-counting**
The Yardi P&L has leaf line items, category subtotals, and grand totals all
sharing the same `category` tag. Summing `ytd_total` across every row in a
category multiplied the real figure ~3x. **Fix:** Key Findings totals now read
directly from anchor GL codes — `45990` (TOTAL REVENUES), `90000` (TOTAL
OPERATING EXPENSES), `90010` (NET OPERATING PROFIT) — with category-sum
fallback only if an anchor GL is missing.

**3. Row cap was breaking forecasts**
Tool 4's original 40-row cap was still in place in Tool 6's branches, truncating
the GL list before reaching anchor totals. **Fix:** raised to 200 rows.

**4. Period label wrong / LLM date hallucination**
Agent was producing labels like "2025-Q3" when the correct period was "2026-Q4"
because: (a) the LLM hallucinated the current date, and (b) period/FY were
read from the agent's guess rather than the file. **Fix:** `compute-financials-v4.js`
now auto-derives both from `forecastMonths[0]` from the actual Yardi file headers.
System prompt also injects today's real date via n8n expression as a secondary fix.

**5. Template binary not accessible in Code nodes (filesystem binary mode)**
n8n 2.28.3's task runner subprocess receives filesystem references for binary
data, not actual base64 content, when `N8N_DEFAULT_BINARY_DATA_MODE=filesystem`
(the default). `XLSX.read()` got empty bytes and returned a workbook with no
sheets. **Fix:** added `N8N_DEFAULT_BINARY_DATA_MODE=default` to the Docker
environment in Hostinger's YAML editor — binary data is now held in memory
during execution. Also: the generator now reads the template binary from
`$input.all()` (scans Merge1's items for one with an xlsx MIME type) rather
than `$('Download Template').first().binary`, which is more reliable in task
runner mode.

**6. _PY_Data sheet writes silently dropped**
SheetJS silently drops cells written outside a sheet's declared `!ref` range.
The `_PY_Data` template sheet starts as `A1:V11` (nearly empty), so writes to
row 14 or row 79+ were lost. **Fix:** `expandRefIfNeeded()` helper auto-expands
`!ref` on every cell write.

**7. Percentage precision mangled by dollar-rounding function**
Small percentages like `+0.5%` (0.005) were being rounded to `0.01` by the 2dp
rounding function used for dollar amounts. **Fix:** `round4()` (4 decimal places)
used for all adj_pct and variance percentage fields.

## exceljs Investigation (Result: Not Usable, Reverted to SheetJS)

Investigated switching from SheetJS (`xlsx`) to `exceljs` to preserve the
template's conditional formatting (yellow override highlighting) and data
validation dropdown (scenario selector), which SheetJS's free tier cannot
write on a load-modify-save round trip.

**Finding:** n8n 2.28.3 executes Code nodes through a separate **Task Runner
subprocess** (`@n8n/task-runner`), which does not honor the main process's
`NODE_PATH`. A startup-command override to install exceljs on every boot
caused a container crash loop. Getting exceljs working would require
n8n's **external-mode task runners** — a separate dedicated runner container
with its own custom Docker image — which is a real infrastructure project,
out of scope for now.

**Decision:** proceed with SheetJS. **Known accepted limitation:** the
generated workbook's scenario dropdown and yellow override-cell highlighting
will not be present — formulas and all data values are correct, but those two
visual/interactive Excel features are lost on every generation. The
`NODE_FUNCTION_ALLOW_EXTERNAL=xlsx,exceljs` and `NODE_PATH` env vars are left
in place (harmless) in case external-mode task runners are set up later.

**Migration note:** this limitation does **not** exist on Power Automate.
Its Excel integration uses the Excel Online (Business) connector (Microsoft
Graph API) or Office Scripts, which operate on the live file through
Microsoft's own Excel engine — conditional formatting and dropdowns are never
at risk. This is a concrete point in favor of the eventual migration. Caveat:
Power Automate's Excel connector requires OneDrive for Business/SharePoint, not
Google Drive — template and outputs would need to move to a Microsoft cloud
location.

## Workbook Template Structure

Template file: `yardi-output/Excel Template/Quarterly_Forecast_Template.xlsx`
(Google Drive — downloaded fresh by Tool 6 on every run)

1. `Forecast` — main P&L; GL Code (col A) is the lookup key; dynamic column
   headers (Actual/Forecast labels + month names) written per run; per-month
   scenario dropdown in row 5 — **dropdown lost in SheetJS output**
2. `Overrides` — full-year mirror layout; forecast-position columns left blank
   (override input cells); yellow highlighting — **lost in SheetJS output**
3. `Assumptions` — per-GL editable Baseline/Upside/Downside % rows; col A lookup key
4. `Key Findings` — executive dashboard (KPIs, occupancy, scenario summary,
   risks/opportunities); management checklist rows 41-45 left as generic boilerplate
5. `_PY_Data` — hidden; FY prior-year annual totals by GL (column O, row 12+);
   row-number aligned to Forecast tab (not GL-keyed)

**Stale-data protection:** the generator clears all GL rows present in the
template but absent from the current run's actuals[] to 0, preventing
prior-property mock numbers from leaking through.

## Google Drive Folder Structure

```
SFA AI Assistant/
  └── yardi-input/
        ├── prop01_actuals.xlsx
        ├── prop01_actuals_py.xlsx
        ├── prop01_budget.xlsx
        ├── prop01_rent_roll.xlsx
        └── [prop02..prop07 same pattern]
  └── yardi-output/
        ├── Excel Template/
        │     └── Quarterly_Forecast_Template.xlsx   ← production template
        └── [generated forecast workbooks]
```

## Folder Guide

- `/docs`        → Design documents, system prompt, schema definitions
- `/workflows`   → n8n workflow JSON exports (commit after each tested change)
- `/code`        → JavaScript for n8n Code nodes (active + archived versions)
- `/sample-data` → Template Yardi export files and forecastData JSON examples

## Active Design Docs

- `/docs/tool6-architecture.md` — node-by-node design of the merged Tool 6
- `/docs/system-prompt.md` — current v6 system prompt (with date injection)
- `/docs/workflow-design.md` — original workflow architecture (partially superseded)
- `/docs/forecastData-schema.md` — internal forecastData schema reference
