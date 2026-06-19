# n8n-SFA-Agents — Bessie Forecasting Agent

## Project Overview
Building an AI-powered quarterly forecasting agent ("Bessie") for a Canadian 
multifamily real estate portfolio using n8n. The agent reads Yardi Voyager 
exports from a local folder, generates 3-scenario forecasts (Baseline, Upside, 
Downside), and outputs a multi-tab Excel workbook.

## Tech Stack
- **Orchestration:** n8n (self-hosted on Hostinger VPS)
- **LLM:** Anthropic Claude claude-sonnet-4-6 (via n8n Anthropic node)
- **Data source:** Yardi Voyager exports (manual file drop — CSV/Excel)
- **Market data:** CMHC Rental Market Survey + Yardi Canada MF Reports
- **Output:** Excel (.xlsx) via SheetJS in n8n Code node

## Portfolio
Properties: TO, TP, LP, BP, 44B, 118B, 99D (Canadian multifamily residential)


## Key Design Decisions
- MVP uses folder-based Yardi input (no direct API) — files dropped to /yardi-input/
- Two entry points: Chat Agent (always-on) + Forecast Workflow (manual/scheduled)
- Agent name: Bessie
- Excel workbook: 6 tabs — Actuals YTD, Baseline, Upside, Downside, Budget vs Forecast, Assumptions
- CMHC API or downloaded Excel tables for Canadian market benchmarks

## Current Phase
Tool 4 (Read Yardi Files) is fully built, tested, and production-
ready as of v2.4 — handles both found and not-found file scenarios
gracefully, dynamically supports all property codes via
PropertyCode/FileType inputs.

Next: Test Tool 5 (Generate Excel) end-to-end with a real forecast
request. See docs/workflow-design.md → "Tool 4 — FINAL Working
Architecture" for the debugging history and exact working config
before making further changes to that sub-workflow.
## Folder Guide
- /docs        → Design documents and specifications
- /workflows   → n8n workflow JSON exports (once built)
- /code        → JavaScript for n8n Code nodes
- /sample-data → Template Yardi export files

## Active Design Doc
See /docs/workflow-design.md for the full node-by-node workflow.
