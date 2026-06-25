# n8n-SFA-Agents — Forecasting Agent

## Project Overview

AI-powered quarterly forecasting agent for a Canadian multifamily real estate
portfolio using n8n. The agent reads Yardi Voyager exports from Google Drive,
incorporates prior-year actuals for YOY trending, generates 3-scenario forecasts
(Baseline, Upside, Downside), and outputs a 5-tab Excel workbook (v4 design).

## Tech Stack

- **Orchestration:** n8n (self-hosted on Hostinger VPS — n8n v2.26.8)
- **LLM:** Anthropic Claude claude-sonnet-4-6 (via n8n Anthropic node)
- **Data source:** Yardi Voyager exports — Google Drive (OAuth2)
- **Market data:** CMHC Rental Market Survey + Yardi Canada MF Reports
- **Output:** Excel (.xlsx) via SheetJS in n8n Code node
- **Environment var:** `NODE_FUNCTION_ALLOW_EXTERNAL=xlsx` (set in Hostinger Docker Manager)

## Portfolio

Properties: TO (prop01), TP (prop02), LP (prop03), BP (prop04),
44B (prop05), 118B (prop06), 99D (prop07) — Canadian multifamily residential

Fiscal year: July 1 – June 30. Functional currency: CAD.

## Key Design Decisions

- Data source: Google Drive (not local VPS folder — original plan superseded)
- Two entry points: Chat Agent (always-on) + Forecast Workflow (deferred — chat-driven forecasting covers the use case)
- Workbook design: v4 — 5 tabs (Forecast, Overrides, Assumptions, Key Findings, _PY_Data)
- Override logic: GL Code + Column keyed (COUNTIFS/SUMIFS) — NOT row-position dependent
- Prior-year data: FY2025 actuals/budget/rent roll in Google Drive with year suffix `(2025)`
- forecastData schema: v2 — includes `pyActuals[]`, `rentRoll{}`, `keyFindings{}`, `dataQuality{}`

## Current Phase (v2.0)

Tool 4 (Read Yardi Files) — **✅ Production v2.5**
- Handles 6 FileTypes: `actuals`, `budget`, `rent_roll` (CY) and `actuals_py`, `budget_py`, `rent_roll_py` (PY)
- Year-aware file matching: CY files exclude `(2025)` suffix; PY files require it
- See `docs/workflow-design.md` → Tool 4 v2.5 section for full architecture

Tool 5 (Generate Excel) — **✅ Production v2.0**
- Produces v4 workbook design (5-tab structure)
- Override formulas use `COUNTIFS`/`SUMIFS` keyed on GL Code + column — not row position
- Conditional formatting uses `DifferentialStyle` + `Rule(type='expression')` — correct XLSX serialization
- `_PY_Data` tab wired and ready to receive FY2025 annual totals from `pyActuals[]`
- See `docs/workflow-design.md` → Tool 5 v2.0 section for full architecture

System Prompt — **✅ v2** (see `docs/system-prompt.md`)
- Explicit 9-step forecasting workflow sequence
- Critical data sourcing rules: cols 8/9/10 = actuals (Jan/Feb/Mar); cols 11/12/13 = budget (NOT actuals)
- forecastData schema v2 construction requirements
- Output standards: structured chat response format

## Workbook v4 Key Principles

**Tab structure:**
1. `Forecast` — main P&L with per-month scenario dropdowns in L5/M5/N5
2. `Overrides` — full-year mirror layout; yellow L/M/N input cells; GL-keyed lookup
3. `Assumptions` — 13 editable scenario % adjustment rows; drives all forecast calcs
4. `Key Findings` — executive dashboard (KPIs, variances, risks, opportunities, checklist)
5. `_PY_Data` — hidden; FY2025 annual totals by GL (column O, row 12+)

**Override formula pattern (Forecast!L{r}):**
```
=IF(AND($A{r}<>"",
     COUNTIFS(Overrides!$A$12:$A$400,$A{r},Overrides!$L$12:$L$400,"<>")>0),
   SUMIFS(Overrides!$L$12:$L$400,Overrides!$A$12:$A$400,$A{r}),
   <AI formula>)
```
Key: column L/M/N is the implicit month key. Robust to row insertions, deletions, reordering.

**CF uses same-sheet helper columns X/Y/Z (COUNTIFS indicators) — no cross-sheet CF dependency.**

## Critical Bug Fixed (v2.0)

Previous analyses incorrectly used budget columns (Apr–Jun, source cols 11–13)
as trailing 3-month actuals. Correct actuals are cols 8/9/10 (Jan/Feb/Mar).
System prompt v2 makes this explicit. All future forecasts use correct columns.

## Folder Guide

- `/docs`        → Design documents, system prompt, schema definitions
- `/workflows`   → n8n workflow JSON exports (commit after each tested change)
- `/code`        → JavaScript for n8n Code nodes (active + archived versions)
- `/sample-data` → Template Yardi export files and forecastData JSON examples

## Active Design Docs

- `/docs/workflow-design.md` — node-by-node workflow architecture (v3.0)
- `/docs/system-prompt.md` — full v2 system prompt for AI Agent node
- `/docs/forecastData-schema.md` — forecastData JSON v2 schema with examples
- `/docs/implementation-plan-v2.md` — phased rollout plan for v2.0 release

