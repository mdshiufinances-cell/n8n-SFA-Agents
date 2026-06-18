# Bessie — n8n Workflow Design

**Version:** 0.1 (Design Phase)
**Last Updated:** 2026-06-18
**Status:** Planning — not yet built in n8n

---

## Overview

Two workflows share one agent (Bessie):

| Workflow | Entry Point | Purpose |
|---|---|---|
| Chat Agent | Chat Trigger | Always-on Q&A against Yardi files |
| Forecast Run | Manual Trigger | Full 3-scenario forecast → Excel output |

Both workflows use the same system prompt, same LLM, and same tools.

---

## Folder Structure (Local Machine / VPS)

/yardi-input/
  ├── actuals_[PERIOD].xlsx
  ├── budget_[YEAR].xlsx
  ├── rent_roll_[DATE].xlsx
  └── market-data/
        └── (CMHC files fetched by n8n or dropped manually)

/yardi-output/
  └── [Property]_Forecast_[Period].xlsx

---

## Workflow 1 — Chat Agent (Always-On)

### Node Map

[Chat Trigger]
      ↓
[AI Agent — Bessie]  ←── [Anthropic Chat Model: Claude claude-sonnet-4-6]
      ↓                   [Window Buffer Memory: 10 messages]
[Chat Response]
      ↑
   Tools:
   ├── Calculator
   ├── Read Yardi Files   (Sub-Workflow)
   ├── Fetch CMHC Data    (HTTP Request)
   ├── Generate Excel     (Sub-Workflow)
   └── Web Search         (SerpAPI)

### Node Configurations

#### Node 1 — Chat Trigger
| Parameter | Value |
|---|---|
| Node type | @n8n/n8n-nodes-langchain.chatTrigger |
| Mode | Hosted Chat |
| Public | false |
| Response mode | Respond when done |

#### Node 2 — AI Agent
| Parameter | Value |
|---|---|
| Node type | @n8n/n8n-nodes-langchain.agent |
| Agent type | Tools Agent |
| System message | [See /docs/system-prompt.md] |
| Prompt | Take from previous node automatically |
| Max iterations | 15 |
| Return intermediate steps | false (set true for debugging) |

#### Sub-node — Anthropic Chat Model
| Parameter | Value |
|---|---|
| Node type | @n8n/n8n-nodes-langchain.lmChatAnthropic |
| Model | claude-sonnet-4-6 |
| Max tokens | 8000 |
| Temperature | 0.2 |

#### Sub-node — Window Buffer Memory
| Parameter | Value |
|---|---|
| Node type | @n8n/n8n-nodes-langchain.memoryBufferWindow |
| Context window | 10 |
| Session ID | {{ $sessionId }} |

---

## Workflow 2 — Forecast Run (Manual Trigger)

### Node Map

[Manual Trigger]
      ↓
[Read/Write Files — Scan /yardi-input/]
      ↓
[Loop Over Items — each file]
      ↓
[Switch — Detect File Type]
   ├── actuals   → [Extract from File] → [Set: label=actuals]
   ├── budget    → [Extract from File] → [Set: label=budget]
   ├── rent_roll → [Extract from File] → [Set: label=rent_roll]
   └── market    → [Extract from File] → [Set: label=market]
      ↓
[Merge — combine all file data]
      ↓
[HTTP Request — CMHC API]
      ↓
[Set — Build Agent Prompt]
      ↓
[AI Agent — Bessie]
      ↓
[Code Node — Excel Builder]
      ↓
[Write File to Disk — /yardi-output/]
      ↓
[Set — Return Summary]

### Node Configurations

#### Node 1 — Manual Trigger
| Parameter | Value |
|---|---|
| Node type | n8n-nodes-base.manualTrigger |
| Notes | Click "Execute Workflow" in n8n to run |

#### Node 2 — Read Files from Disk
| Parameter | Value |
|---|---|
| Node type | n8n-nodes-base.readWriteFile |
| Operation | Read File(s) From Disk |
| File path | /home/n8n/yardi-input/** |
| Output field | data |

#### Node 3 — Loop Over Items
| Parameter | Value |
|---|---|
| Node type | n8n-nodes-base.splitInBatches |
| Batch size | 1 |

#### Node 4 — Switch (File Type Detection)
| Parameter | Value |
|---|---|
| Node type | n8n-nodes-base.switch |
| Value to check | {{ $json.fileName.toLowerCase() }} |
| Rule 1 | Contains "actual" → Output 0 |
| Rule 2 | Contains "budget" → Output 1 |
| Rule 3 | Contains "rent" → Output 2 |
| Rule 4 | Contains "cmhc" or "report" → Output 3 |

#### Node 5 — Extract from File
| Parameter | Value |
|---|---|
| Node type | n8n-nodes-base.extractFromFile |
| Operation | XLSX or CSV (auto from extension) |
| First row as headers | true |
| Input binary field | data |

#### Node 6 — HTTP Request (CMHC API)
| Parameter | Value |
|---|---|
| Node type | n8n-nodes-base.httpRequest |
| Method | GET |
| URL (vacancy) | https://www03.cmhc-schl.gc.ca/hmip-pimh/en/api/tableData/2.2.26 |
| URL (avg rent) | https://www03.cmhc-schl.gc.ca/hmip-pimh/en/api/tableData/2.2.28 |
| Query param: lang | en |
| Query param: selectedGeography | Toronto (or dynamic from property data) |
| Query param: period | 2025 |
| Notes | If API fails, fall back to CMHC Excel files in /market-data/ |

#### Node 7 — Set (Build Agent Prompt)
| Parameter | Value |
|---|---|
| Node type | n8n-nodes-base.set |
| prompt | Generate a quarterly forecast for all properties. Produce 3 scenarios (Baseline, Upside, Downside). Return ONLY valid JSON. Data: {{ JSON.stringify($json) }} |

#### Node 8 — AI Agent (Forecast Mode)
| Parameter | Value |
|---|---|
| Agent type | Tools Agent |
| System message | [See /docs/system-prompt.md] |
| Max iterations | 20 |
| Output format | JSON |

#### Node 9 — Code Node (Excel Builder)
| Parameter | Value |
|---|---|
| Node type | n8n-nodes-base.code |
| Language | JavaScript |
| Code | [See /code/excel-generator.js] |

#### Node 10 — Write File to Disk
| Parameter | Value |
|---|---|
| Node type | n8n-nodes-base.readWriteFile |
| Operation | Write File to Disk |
| File path | /home/n8n/yardi-output/{{ $json.fileName }} |
| Input binary field | data |

---

## Tool Definitions

### Tool 1 — Calculator
| Parameter | Value |
|---|---|
| Node type | @n8n/n8n-nodes-langchain.toolCalculator |
| Name | calculator |
| Description | Use for all math: NOI, variance %, rent growth, occupancy rates, YTD totals. Never estimate — always use this tool for numeric computation. |

### Tool 2 — Read Yardi Files
| Parameter | Value |
|---|---|
| Node type | @n8n/n8n-nodes-langchain.toolWorkflow |
| Name | read_files |
| Description | Read financial data files from /yardi-input/. Returns actuals, budget, rent roll as structured JSON. Call this FIRST when asked about property performance or budget data. |
| Sub-workflow | [See /workflows/tool-read-yardi-files.json] |
| Code | [See /code/read-yardi-files.js] |

### Tool 3 — Fetch CMHC Data
| Parameter | Value |
|---|---|
| Node type | @n8n/n8n-nodes-langchain.toolHttpRequest |
| Name | fetch_cmhc |
| Description | Fetch CMHC vacancy rate and avg rent benchmarks for a Canadian CMA. Pass CMA name (e.g. Toronto, Calgary, Edmonton, Ottawa). Returns vacancy %, avg rent by bedroom type, turnover rate. |
| Vacancy URL | https://www03.cmhc-schl.gc.ca/hmip-pimh/en/api/tableData/2.2.26 |
| Avg Rent URL | https://www03.cmhc-schl.gc.ca/hmip-pimh/en/api/tableData/2.2.28 |
| Params | lang=en, selectedGeography={cma}, period=2025 |

### Tool 4 — Generate Excel
| Parameter | Value |
|---|---|
| Node type | @n8n/n8n-nodes-langchain.toolWorkflow |
| Name | generate_excel |
| Description | Generate a multi-tab Excel workbook with: 1.Actuals YTD, 2.Baseline Forecast, 3.Upside, 4.Downside, 5.Budget vs Forecast, 6.Assumptions. Pass forecast data as JSON. Returns filename and confirms save to /yardi-output/. |
| Sub-workflow | [See /workflows/tool-generate-excel.json] |
| Code | [See /code/excel-generator.js] |

### Tool 5 — Web Search
| Parameter | Value |
|---|---|
| Node type | @n8n/n8n-nodes-langchain.toolSerpApi |
| Name | web_search |
| Description | Search for current Canadian rental market news or data not available in loaded files. Use sparingly. Always cite source and date in response. |
| API key | [Store in n8n credentials as SerpAPI] |

---

## Data Flow

### Input Files → Agent

/yardi-input/actuals_*.xlsx   → actuals[]   (GL by property/period)
/yardi-input/budget_*.xlsx    → budget[]    (approved annual budget)
/yardi-input/rent_roll_*.xlsx → rent_roll[] (unit-level snapshot)
CMHC API response             → market[]    (vacancy, avg rent by CMA)

### Agent → Excel Output

AI Agent returns JSON:
{
  property, period,
  actuals[], baseline[], upside[], downside[],
  variance[], assumptions[]
}
        ↓
Code Node (excel-generator.js) builds .xlsx
        ↓
/yardi-output/[Property]_Forecast_[Period].xlsx

---

## Open Decisions

| # | Decision | Status |
|---|---|---|
| 1 | n8n hosted locally or on Hostinger VPS? | TBD |
| 2 | SerpAPI or Tavily for web search? | TBD |
| 3 | Single workflow or separate workflows for Chat vs Forecast? | Separate |
| 4 | Sub-workflows for tools or inline Code nodes? | TBD |
| 5 | CMHC API fallback strategy if endpoint changes? | TBD |

---

## Next Steps

- [ ] Create /docs/system-prompt.md
- [ ] Create /code/excel-generator.js
- [ ] Create /code/read-yardi-files.js
- [ ] Resolve open decisions above
- [ ] Build Chat Agent workflow in n8n first
- [ ] Test with sample Yardi files
- [ ] Build Forecast workflow second
