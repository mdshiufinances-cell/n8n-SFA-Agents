# n8n-SFA-Agents — Forecasting Agent

## Project Overview

AI-powered quarterly forecasting agent for a Canadian multifamily real estate
portfolio using n8n. The agent reads Yardi Voyager exports from Google Drive,
incorporates prior-year actuals for YOY trending, generates 3-scenario forecasts
(Baseline, Upside, Downside), and populates a 4-tab Excel template (Forecast,
Overrides, Assumptions, Key Findings, plus a hidden `_PY_Data` tab).

## Tech Stack

- **Orchestration:** n8n (self-hosted on Hostinger VPS — n8n v2.28.3)
- **LLM:** Anthropic Claude claude-sonnet-4-6 (via n8n Anthropic node)
- **Data source:** Yardi Voyager exports — Google Drive (OAuth2)
- **Market data:** CMHC Rental Market Survey + Yardi Canada MF Reports
- **Output:** Excel (.xlsx) via SheetJS in n8n Code node, populating a stored template
- **Environment vars:** `NODE_FUNCTION_ALLOW_EXTERNAL=xlsx,exceljs`, `NODE_PATH=/usr/local/lib/node_modules/n8n-extra/node_modules` (set in Hostinger Docker Manager — see "exceljs Investigation" below; only `xlsx` is actually usable today)

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
- Override logic: GL Code keyed (COUNTIFS/SUMIFS) — NOT row-position dependent
- Prior-year data: FY2025 actuals/budget/rent roll in Google Drive (`_py` suffix files)
- forecastData schema: v2-equivalent internal object — includes `pyActuals[]`,
  `rentRoll{}`, `keyFindings{}`, `dataQuality{}` — but this object now **stays
  inside Tool 6's execution** and is never passed back through the agent.
- **Key Findings totals use anchor GL codes, not category summation.** See
  "Critical Bugs Fixed" below — summing every row tagged with a category
  double/triple-counts subtotal and grand-total rows.

## Current Phase (v3.0 — Tool 6 Merged Architecture)

**Tool 6 (Compute Financials + Generate Excel) — ✅ Production v4**
- Single sub-workflow, single agent-facing tool
- Internally: 4 parallel Google Drive read branches (actuals, actuals_py,
  budget, rent_roll) → Merge → Compute Financials v4 → Generate Excel
  Workbook → Google Drive Upload → Format Output
- Trigger schema: `propertyCode`, `period`, `fiscalYear` (3 strings only)
- Returns: `fileName`, `driveLink`, `tabs`, `keyFindings` — small summary only
- See `docs/tool6-architecture.md` for full node-by-node design

**Tool 4 (Read Yardi Files) — ✅ Still production, but NOT used in forecasting**
- Its internal file-reading/period-detection logic (v3.3 formatter) has been
  duplicated into Tool 6's 4 branches, each with a hardcoded `fileType` per
  branch (since Tool 6's trigger has no `FileType` field)
- Retained as a standalone agent tool only for ad-hoc one-off file lookups

**Tool 5 (Generate Excel) — ❌ Removed as a standalone agent tool**
- Its logic now lives inside Tool 6 as the "Generate Excel Workbook" node
- The standalone sub-workflow and its AI Agent tool connection should be
  deleted/disconnected once Tool 6's merged version is confirmed stable

System Prompt — **✅ v5** (see `docs/system-prompt.md`)
- 2-step workflow: call Tool 6 → respond. No Tool 4 or Tool 5 calls for forecasts.
- Calculator explicitly disallowed — Tool 6 handles all arithmetic
- Expected iterations: 2–3 (down from the original 30+ that caused the v2→v3 rebuild)

## Critical Bugs Fixed (v3)

**1. GL Code / Account Name column misalignment**
`keyPositionMap` was built from the Yardi file's month-label header row, which
is missing the GL Code and Account Name keys (those cells are blank on header
rows, so n8n drops the keys). This shifted every column left by 2, causing
dollar values to be miscast as GL codes. **Fix:** build `keyPositionMap` from
the *widest* data row (most keys) instead of the header row — a fully
populated GL data row always has all columns present.

**2. Key Findings double/triple-counting**
The Yardi P&L has leaf line items, category subtotals, and grand totals all
sharing the same `category` tag (e.g. `41100` Rent Revenue, `41990` Total Rent
Revenue, and `45990` TOTAL REVENUES are all `category: "Revenue"`). Summing
`ytd_total` across every row in a category multiplied the real figure ~3x.
**Fix:** Key Findings totals now read directly from anchor GL codes —
`45990` (TOTAL REVENUES), `90000` (TOTAL OPERATING EXPENSES), `90010` (NET
OPERATING PROFIT) — with a category-sum fallback (flagged via
`dataQuality.warningFlags`) only if an anchor GL is missing from the data.

**3. Row cap was breaking forecasts**
Tool 4's original 40-row cap existed to protect the LLM's context window when
file data was passed directly to the agent. In the Tool 6 architecture this
data never reaches the agent, so the cap was obsolete — but it was still
truncating the GL list before reaching `87990`/`89190`/`89290`/`89390`/`90000`/
`90010`, breaking R&M, Utilities, Realty Tax, Mgmt Fee, and the anchor totals
entirely. **Fix:** raised to 200 rows (a typical P&L has ~100–130 lines).

## exceljs Investigation (Result: Not Usable, Reverted to SheetJS)

Investigated switching from SheetJS (`xlsx`) to `exceljs` to preserve the
template's conditional formatting (yellow override highlighting) and data
validation dropdown (scenario selector), which SheetJS's free tier cannot
write on a load-modify-save round trip.

**Finding:** n8n 2.28.3 executes Code nodes through a separate **Task Runner
subprocess** (`@n8n/task-runner`), which does not honor the main process's
`NODE_PATH`. A startup-command override to install exceljs on every boot
caused a container crash loop (Hostinger's platform didn't accept the command
array syntax cleanly) and was reverted. Getting exceljs working would require
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
Microsoft's own Excel engine rather than reconstructing the file format from
scratch — conditional formatting and dropdowns are never at risk. This is a
concrete point in favor of the eventual migration, not just a platform
preference. Caveat: Power Automate's Excel connector requires
OneDrive for Business/SharePoint storage, not Google Drive — the template and
generated workbooks would need to live in (or sync to) a Microsoft cloud
location if/when migrated.

## Workbook Template Structure

The production template (not generated from scratch — populated each run):

1. `Forecast` — main P&L; GL Code (col A) is the lookup key; per-month
   scenario dropdown in row 5 (L5/M5/N5) — **dropdown lost in SheetJS output,
   see exceljs note above**
2. `Overrides` — full-year mirror layout; yellow L/M/N input cells — **yellow
   highlighting lost in SheetJS output**; GL-keyed lookup, row order doesn't matter
3. `Assumptions` — per-GL editable Baseline/Upside/Downside % adjustment rows;
   column A (GL Code) is the lookup key — do not reorder
4. `Key Findings` — executive dashboard (KPIs, occupancy, scenario summary,
   risks/opportunities, management checklist)
5. `_PY_Data` — hidden; FY2025 annual totals by GL (column O, row 12+);
   `Forecast` tab pulls via `=IFERROR(_PY_Data!O{row},"")`

**Override formula pattern (Forecast!L{r}):**
```
=IF(AND($A{r}<>"",
     COUNTIFS(Overrides!$A$12:$A$400,$A{r},Overrides!$L$12:$L$400,"<>")>0),
   SUMIFS(Overrides!$L$12:$L$400,Overrides!$A$12:$A$400,$A{r}),
   <AI formula>)
```
GL Code is the lookup key — robust to row insertions, deletions, reordering.

## Folder Guide

- `/docs`        → Design documents, system prompt, schema definitions
- `/workflows`   → n8n workflow JSON exports (commit after each tested change)
- `/code`        → JavaScript for n8n Code nodes (active + archived versions)
- `/sample-data` → Template Yardi export files and forecastData JSON examples

## Active Design Docs

- `/docs/tool6-architecture.md` — **NEW**, node-by-node design of the merged Tool 6 (v3 architecture)
- `/docs/workflow-design.md` — original node-by-node workflow architecture (v3.0, pre-merge — partially superseded by tool6-architecture.md)
- `/docs/system-prompt.md` — current v5 system prompt for AI Agent node
- `/docs/forecastData-schema.md` — internal forecastData JSON schema (now used only inside Tool 6, not passed through the agent)
- `/docs/implementation-plan-v2.md` — phased rollout plan (historical — v2.0 release; superseded by v3 pivot)
