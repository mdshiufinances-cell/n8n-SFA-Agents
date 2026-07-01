# Forecasting Agent — n8n Workflow Design

**Version:** 5.0
**Last Updated:** 2026-07-01
**Status:** Tool 6 v4.1 production (merged architecture — reads files, computes, generates Excel, uploads in one sub-workflow). System prompt v6. All major components live and tested.

> ⚠️ **This document reflects the v3.1 as-built architecture.** The previous version (v4.0) documented the 3-tool design (Tool 4 → Tool 6 → Tool 5) which was abandoned in production — see CLAUDE.md → "Major Architecture Pivot" for why. Tool 5 as a standalone agent-callable tool no longer exists. Tool 4 still exists but is no longer called by the agent for forecast runs.

---

## Overview

One agent, accessible via chat:

| Entry Point | Purpose | Status |
|---|---|---|
| Chat Trigger (n8n Chat Hub) | Always-on Q&A + on-demand forecasting | ✅ Live |
| Manual/Scheduled Forecast Run | Batch quarterly forecast | ⏳ Deferred — chat-driven covers the use case |

---

## Data Source

**Implementation:** Google Drive, connected via OAuth2 credential ("Google Drive account").

### Google Drive Folder Structure

```
SFA AI Assistant/
  └── yardi-input/
        ├── prop01_actuals.xlsx          ← CY actuals (current year)
        ├── prop01_actuals_py.xlsx       ← PY actuals (prior year)
        ├── prop01_budget.xlsx           ← CY budget
        ├── prop01_rent_roll.xlsx        ← CY rent roll
        └── [prop02..prop07 same pattern]
  └── yardi-output/
        ├── Excel Template/
        │     └── Quarterly_Forecast_Template.xlsx   ← production template
        └── [property]_Forecast_[period].xlsx        ← generated workbooks
```

**Naming convention:** Files use `prop01_` prefix. PY files use `_py` suffix.
No year in filename — period is implicit from file type.

> **Note:** `budget_py` and `rent_roll_py` FileTypes exist in Tool 4's pattern map but
> are not yet being used in Tool 6 (only actuals, actuals_py, budget, rent_roll are read).

### Property Mapping

| Friendly Name | File Code | Yardi Internal Code |
|---|---|---|
| TO | prop01 | dunf0045 |
| TP | prop02 | (TBD) |
| LP | prop03 | (TBD) |
| BP | prop04 | (TBD) |
| 44B | prop05 | balli118 |
| 118B | prop06 | (TBD) |
| 99D | prop07 | davis099 |

Replace prop01–prop07 test codes with real Yardi codes before production rollout.

---

## Source File Column Mapping — Dynamic

**⚠️ CRITICAL — Read before modifying any data sourcing logic.**

### Fixed column positions (always true)

| Col index (0-based) | Excel col | Content |
|---|---|---|
| 0 | A | GL Code |
| 1 | B | Account Name |
| 2–13 | C–N | Monthly values — Jul through Jun (12 months in FY order) |
| 14 | O | Total Actual + Budget |
| 15 | P | Original Annual Budget |

### Dynamic split — actuals vs forecast

The boundary between actual and budget columns depends on when the file was exported from Yardi. Tool 6's formatter branches detect this automatically via two methods:

**Method 1 — Header scan (preferred):** Scans first 10 rows for a row with 6+ month-label cells (e.g. "Jul 2025"). Compares each period-end date to today. Returns `detectionMethod: "header_scan"`.

**Method 2 — Date arithmetic fallback:** Derives split from today's date and fiscal year start (July 1). Returns `detectionMethod: "date_arithmetic_fallback"`. A warning is added to `dataQuality.warningFlags` when this fallback is used.

### Example: FY2026 (Jul 2025 – Jun 2026) at different export dates

| File exported | `actualsMonths` | `forecastMonths` | `trailingAvgMonths` |
|---|---|---|---|
| Sep 30, 2025 | Jul–Sep 2025 (3 mo) | Oct 2025–Jun 2026 (9 mo) | Jul / Aug / Sep 2025 |
| Dec 31, 2025 | Jul–Dec 2025 (6 mo) | Jan–Jun 2026 (6 mo) | Oct / Nov / Dec 2025 |
| Mar 31, 2026 | Jul 2025–Mar 2026 (9 mo) | Apr–Jun 2026 (3 mo) | Jan / Feb / Mar 2026 |
| Jun 30, 2026 | Jul 2025–Jun 2026 (12 mo) | none | Apr / May / Jun 2026 |

### ❌ What NOT to do

- Do NOT hardcode trailing average positions (e.g. "cols 8/9/10 = Jan/Feb/Mar") — only true for a 9-month export
- Do NOT include `forecastMonths` in YTD calculations
- Do NOT assume cols 11/12/13 = budget — these may be actuals in later-year exports

---

## Workflow 1 — Bessie Chat Agent (LIVE)

### Node Map (AI Agent level)

```
[Chat Trigger]
      ↓
[AI Agent]  ←── [Anthropic Chat Model: claude-sonnet-4-6]
      ↓          [Simple Memory: 10 messages]
[Chat Response]
      ↑
   Tools:
   ├── Tool 1: Calculator
   ├── Tool 2: Web Search (SerpAPI)
   ├── Tool 3: HTTP Request — CMHC Data
   ├── Tool 4: Call 'Tool — Read Yardi Files' (ad-hoc only — NOT called for forecasts)
   └── Tool 6: Call 'Tool — Compute Financials' ← the only forecasting tool
```

### AI Agent Node Configuration

| Parameter | Value |
|---|---|
| Agent type | Tools Agent |
| System message | See `/docs/system-prompt.md` — use v6 (includes `{{ $now.format('YYYY-MM-DD') }}` date injection) |
| Max Iterations | 10 (2–3 iterations expected for a forecast) |
| Temperature | 0.2 |
| Max tokens | 4000 |
| Memory | Simple Memory, 10 messages |

---

## Tool 6 — Compute Financials + Generate Excel (MAIN TOOL)

**Status: ✅ Production v4.1 — merged architecture**

### Why merged into one sub-workflow

The original design (Tool 4 → agent → Tool 6 → agent → Tool 5) failed twice because the agent dropped large JSON payloads when relaying data between tools. Fix: Tool 6 reads its own files, computes everything, and generates the workbook — all internally. The agent only passes 3 short strings in and receives a small summary back. The large `forecastData` object never passes through the agent at all.

### Trigger Input Schema

```
propertyCode  (String)  — e.g. "prop01"
period        (String)  — hint only; auto-overridden from file data (see below)
fiscalYear    (String)  — hint only; auto-overridden from file data
```

### Internal Node Map

```
[When Executed by Another Workflow]
        ↓ (5 parallel branches)
   ┌────┬─────┬──────────┬───────────┬───────────────────┐
[Search  [Search  [Search  [Search    [Search
 actuals] actuals_py] budget] rent_roll] template]
   ↓         ↓          ↓        ↓          ↓
[Match    [Match    [Match    [Match    [Download
 File]     File]     File]     File]     Template]
   ↓         ↓          ↓        ↓
  [IF]      [IF]       [IF]     [IF]
true/false true/false true/false true/false
   ↓    ↓     ↓    ↓     ↓    ↓     ↓    ↓
[Down- [Not  [Down- [Not  [Down- [Not  [Down- [Not
 load]  Fnd]  load]  Fnd]  load]  Fnd]  load]  Fnd]
   ↓            ↓            ↓            ↓
[Extract]    [Extract]    [Extract]    [Extract]
   ↓            ↓            ↓            ↓
[Code:       [Code:       [Code:       [Code:
 formatter    formatter    formatter    formatter
 actuals]     actuals_py]  budget]      rent_roll]
   ↓            ↓            ↓            ↓
[Set:        [Set:        [Set:        [Set:
 fileType]    fileType]    fileType]    fileType]
   └────────────┴────────────┴────────────┘
                       ↓ (8 inputs — 4 true + 4 false branches)
               [Merge — Append mode]
                       ↓
          [Code: Compute Financials v4]
                       ↓                    ↓
                  (JSON output)      [Download Template]
                       └──────────────────┘
                       ↓ (Merge1 — 2 inputs: Compute Financials v4 + Download Template)
               [Merge1 — Append mode]
                       ↓
          [Code: Generate Excel Workbook]  ← reads forecastData + template binary from $input.all()
                       ↓
          [Google Drive — Upload file → yardi-output/]
                       ↓
          [Code: Format Output]  ← returns small summary only, never raw forecastData
```

### Key node details

#### Formatter branches (×4)
Same logic as Tool 4 v3.3 (header scan period detection, GL filtering, named month keys), with two hardcoded changes per branch:
- `fileType` is a literal string (not read from trigger — Tool 6's trigger has no FileType field)
- `propertyCode` reads from `trigger.propertyCode` (lowercase — differs from Tool 4's `PropertyCode`)
- Row cap: **200** (raised from Tool 4's original 40 — data stays inside Tool 6, never reaches the LLM)
- Always Output Data: ON on every node

#### Not Found placeholders (false branches ×4)
```javascript
return [{ json: { fileType: '<branch>', output: JSON.stringify({ success: false }) } }];
```
Ensures Merge always receives 8 items regardless of which files were found.

#### Download Template branch
- Search node: queries `Quarterly_Forecast_Template.xlsx` in folder `yardi-output/Excel Template/`
- Download node: Resource=File, Operation=Download, File By ID=`{{ $json.id }}`
- Named exactly **`Download Template`** — referenced by this name in the Generate Excel Workbook code

#### Merge (first — 8 inputs)
Mode: Append. Combines all 4 true-branch Set nodes + 4 false-branch Code nodes.

#### Compute Financials v4
- Reads `$input.all()`, sorts by fileType, builds `forecastData` object
- **Auto-derives `period` and `fiscalYear`** from `forecastMonths[0]` (file-driven, not agent-driven)
  - Q1 = Jul–Sep, Q2 = Oct–Dec, Q3 = Jan–Mar, Q4 = Apr–Jun
  - e.g. `forecastMonths[0] = "Apr 2026"` → `period = "2026-Q4"`, `fiscalYear = "FY2026"`
- Key Findings totals use anchor GL codes (45990/90000/90010), not category summation
- Exposes `actualsMonths`, `forecastMonths`, `trailingAvgMonths` in output (used by Excel generator)

#### Merge1 (second — 2 inputs)
Mode: Append. Combines Compute Financials v4 (JSON) + Download Template (binary).

#### Generate Excel Workbook (dynamic)
- Reads forecastData from `$('Compute Financials v4').first().json`
- Reads template binary from `$input.all()` (scans for item with xlsx MIME type) — NOT from `$('Download Template').first().binary`, which is unreliable in n8n's task runner filesystem binary mode
- Writes data cells only: actuals C–K, budget S, assumptions %, prior-year O, Key Findings KPIs
- All formulas in the template (override lookup, trailing avg, totals, YOY) left untouched
- Dynamic column split: actual/forecast boundary computed from `actualsMonths.length`; formulas generated per forecast column; helper columns X–AF (up to 9 forecast months)
- Stale data protection: GL rows in template but absent from current actuals[] are cleared to 0
- **Known limitation:** SheetJS cannot preserve conditional formatting or data validation dropdowns on load-modify-save. Scenario dropdown and yellow override highlighting are lost. See CLAUDE.md → "exceljs Investigation".

#### Format Output (final node)
Returns only: `{ success, fileName, property, period, driveFileId, driveLink, tabs, keyFindings }`.
Never returns raw `forecastData`. Output field must be named `output` as a JSON string (ToolWorkflow v2 requirement).

### Tool 6 Agent-facing description

> Compute the full forecast and generate the Excel workbook. Reads all required files internally — do NOT call Tool 4 first. Parameters: propertyCode (e.g. "prop01"), period (hint only — auto-derived from file), fiscalYear (hint only). Returns fileName, driveLink, tabs, keyFindings.

---

## Tool 4 — Read Yardi Files (AD-HOC ONLY)

**Status: ✅ Production v3.3 — NOT called by agent for forecast runs**

Tool 4 still exists as a standalone sub-workflow for ad-hoc one-off file lookups (e.g. "show me the GL detail for prop02 actuals"). Its internal logic (period detection, GL filtering, named month keys) has been duplicated into Tool 6's 4 formatter branches.

### Trigger Input Schema (case-sensitive)

```
PropertyCode  (String)  — e.g. prop01
FileType      (String)  — actuals | budget | rent_roll | actuals_py | budget_py | rent_roll_py
```

⚠️ n8n expressions are case-sensitive. Always use `$json.PropertyCode`, not `$json.propertyCode`.

For full node-by-node architecture see the v4.0 version of this document (historical) or the code in `code/formatter-actuals.js` etc.

---

## Tool 5 — Generate Excel (DEPRECATED)

**Status: ❌ Removed as a standalone agent-callable tool**

Excel generation now happens inside Tool 6. The standalone "Tool — Generate Excel" sub-workflow can be deleted or archived. It is no longer connected to the AI Agent node.

---

## Key Lessons Learned

Read before modifying ANY sub-workflow or environment configuration.

1. **LLMs cannot relay large JSON blobs between tool calls.** Parameters exceeding ~10KB are silently dropped. Always make sub-workflows self-contained — accept lightweight identifiers, fetch data internally. This single lesson drove the entire v3 architecture pivot.

2. **n8n 2.28.3 task runner cannot read binary files from named nodes.** In `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` (the previous default), Code nodes receive filesystem references, not actual base64, when accessing `$('NodeName').first().binary`. Fix: set `N8N_DEFAULT_BINARY_DATA_MODE=default` in the Docker environment so binary data is held in memory. Also: read binary from `$input.all()` (Merge node's direct output) rather than reaching back to a named node — more reliable.

3. **Period/fiscalYear must be file-driven, not agent-driven.** LLMs hallucinate dates (the agent produced "2025-Q3" when the correct answer was "2026-Q4"). Fix: auto-derive both from `forecastMonths[0]` inside `compute-financials-v4.js`. Inject real current date into the system prompt via `{{ $now.format('YYYY-MM-DD') }}` as a secondary safeguard.

4. **SheetJS silently drops writes outside a sheet's `!ref` range.** The `_PY_Data` template sheet starts as `A1:V11`. Writing to row 79 (e.g. GL 45990) is silently lost unless `!ref` is expanded first. Fix: `expandRefIfNeeded()` helper updates `!ref` on every `setCell()` call.

5. **Category-summation double/triple-counts P&L rows.** The Yardi P&L has leaf items, subtotals, and grand totals all sharing the same category tag. Summing by category multiplies the real figure ~3x. Fix: always use anchor GL codes (45990/90000/90010) for KPI totals.

6. **Row cap must be raised when data stays inside the sub-workflow.** Tool 4's 40-row cap existed to protect the LLM's context window. In Tool 6 the data never reaches the LLM, so the cap was silently truncating the GL list before anchor totals. Fix: raised to 200 rows.

7. **n8n field names are case-sensitive.** Workflow Input Schema fields are referenced exactly downstream — `propertyCode` ≠ `PropertyCode`. Tool 4 uses `PropertyCode` (uppercase P); Tool 6 uses `propertyCode` (lowercase p). Mixing these causes silent failures.

8. **ToolWorkflow v2 requires `output` as a JSON string.** The final node must return `{ output: JSON.stringify({...}) }`. Returning a raw JSON object causes "workflow did not return a response" errors.

9. **Always Output Data must be ON on every node.** Without it, n8n silently halts on zero-item results rather than passing a graceful empty/error item downstream.

10. **Docker env var changes require YAML editor + force-recreate.** Hostinger's visual editor separates the environment panel from the YAML — changes in the visual panel only affect `${...}` variable substitutions, not hardcoded literal values in the `environment:` block. Always edit the YAML directly and ensure the container is recreated (not just restarted) for env changes to take effect.

11. **Google Drive OAuth token expires periodically.** If all file branches return not-found simultaneously, reconnect the "Google Drive account" credential in Settings → Credentials before debugging anything else.

12. **Template updates are Drive-only.** To change the Excel template, replace `Quarterly_Forecast_Template.xlsx` in `yardi-output/Excel Template/`. No code changes needed — Tool 6 downloads the template fresh on every run.

---

## Environment Variables (Hostinger Docker Manager YAML — all required)

| Variable | Value | Purpose |
|---|---|---|
| `NODE_FUNCTION_ALLOW_EXTERNAL` | `xlsx,exceljs` | Allows `require('xlsx')` in Code nodes |
| `NODE_PATH` | `/usr/local/lib/node_modules/n8n-extra/node_modules` | Future exceljs path (harmless now) |
| `N8N_DEFAULT_BINARY_DATA_MODE` | `default` | Binary data in memory — required for Code nodes to read downloaded files |
| `N8N_TRUST_PROXY` | `true` | Required for Traefik reverse proxy |
| `GENERIC_TIMEZONE` | `${TZ}` | From environment substitution panel |

---

## CMHC & Market Data Sources

| Source | Access Method | Status |
|---|---|---|
| CMHC Rental Market Survey | HTTP Request Tool (Tool 3) | ✅ Working, Toronto only (hardcoded) |
| Yardi Canada MF Quarterly Report | Manual download → Drive /market-data/ as PDF | ✅ Files in place |
| Urbanation + Rentsync | Not yet integrated | ⏳ Future |

---

## Open Decisions

| # | Decision | Status |
|---|---|---|
| 1 | n8n hosting | Self-hosted Hostinger VPS (n8n v2.28.3) |
| 2 | Web search | SerpAPI — confirmed, working |
| 3 | Chat vs batch forecast | Chat-driven; batch deferred |
| 4 | Excel library | SheetJS (xlsx) — exceljs blocked by task runner architecture (see CLAUDE.md) |
| 5 | CMHC geography | Hardcoded Toronto — future: dynamic per property CMA |
| 6 | Property code format | prop01–prop07 test codes; replace with real Yardi codes before production |
| 7 | Power Automate migration | Noted — resolves the SheetJS CF/dropdown limitation; requires OneDrive storage |

---

## Completed / In Progress

- [x] Tool 4 v3.3 — dynamic period detection, GL filtering, named month keys
- [x] Tool 6 v4 — merged architecture (reads + computes + generates Excel in one sub-workflow)
- [x] Tool 6 v4.1 — template population (dynamic, any quarter), binary mode fix, period auto-derivation
- [x] System prompt v6 — date injection, 2-step workflow, Tool 4 excluded from forecast path
- [x] Template stored in Google Drive (yardi-output/Excel Template/)
- [x] N8N_DEFAULT_BINARY_DATA_MODE=default deployed
- [x] End-to-end test: prop01 Q4 FY2026 forecast generated successfully

## Next Steps

- [ ] Commit current n8n workflow JSONs to /workflows/
- [ ] Replace prop01–prop07 test codes with real Yardi property codes
- [ ] Make CMHC HTTP Request dynamic by CMA (not hardcoded Toronto)
- [ ] Test remaining 6 properties (prop02–prop07) with real Yardi files
- [ ] Implement Telegram user ID whitelist (security layer — highest priority)
- [ ] Evaluate Power Automate migration path for full template fidelity (CF + dropdowns)
