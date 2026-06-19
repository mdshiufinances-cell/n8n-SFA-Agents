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


---

## Tool 4 — Read Yardi Files: FINAL Working Architecture (v2.4)

**Status: ✅ Production-tested for prop01 (found) and prop02 (not found)**

### Final Node Structure

[When Executed by Another Workflow]
        ↓
[Search files and folders]   (Always Output Data: ON)
        ↓
[Match File]                  (Code node, Always Output Data: ON)
        ↓
[IF: found === true]
   ↙ true                  ↘ false
[Download file]      [Not Found Message]  (Code node, final node)
   ↓
[Extract from File]   (Always Output Data: ON)
   ↓
[Code in JavaScript]   (formats success output)

### Trigger Input Schema (case-sensitive!)
Field names as defined in "When Executed by Another Workflow":
  PropertyCode  (String)
  FileType      (String)

IMPORTANT: n8n expressions are case-sensitive. All downstream
references MUST use the exact casing: $json.PropertyCode, not
$json.propertyCode. This caused a multi-hour outage when the
Search node's query still referenced the lowercase version
after the dynamic expression was reinstated.

### Search files and folders config
  Search Query: {{ $json.PropertyCode }}
  Filter: Folder = yardi-input
  Always Output Data: ON

### Match File (Code node) — replaces old "Filter" node
```javascript
const triggerData = $('When Executed by Another Workflow').first().json;
const fileType = triggerData.FileType;
const propertyCode = triggerData.PropertyCode;

const items = $input.all();

const patternMap = {
  actuals: 'actualbudget',
  budget: 'monthbudget',
  rent_roll: 'rentroll'
};
const pattern = patternMap[fileType] || fileType;

const match = items.find(item => {
  const name = (item.json.name || '').toLowerCase().replace(/_/g, '');
  return item.json.id && name.includes(pattern);
});

if (match) {
  return [{ json: { found: true, id: match.json.id, name: match.json.name, propertyCode, fileType } }];
}
return [{ json: { found: false, propertyCode, fileType } }];
```

### IF node
  Condition: {{ $json.found }}  is true  (Boolean)

### Not Found Message (Code node, FALSE branch, final node)
```javascript
const j = $input.first().json;
return [{
  json: {
    output: JSON.stringify({
      success: false,
      message: `No ${j.fileType} file found for property ${j.propertyCode}. Please confirm the file has been uploaded to /yardi-input/ with the correct naming convention.`
    })
  }
}];
```

### Code in JavaScript (TRUE branch, after Extract from File)
```javascript
const items = $input.all();

if (!items || items.length === 0 || !items[0].json || Object.keys(items[0].json).length === 0) {
  const propertyCode = $('When Executed by Another Workflow').first().json.PropertyCode;
  const fileType = $('When Executed by Another Workflow').first().json.FileType;
  return [{
    json: {
      output: JSON.stringify({
        success: false,
        message: `No ${fileType} file found for property ${propertyCode}.`
      })
    }
  }];
}

const fileType = $('When Executed by Another Workflow').first().json.FileType || 'actuals';
const rows = items.map(item => item.json);

const keyGLCodes = ['41100','41110','41200','41990','42100','42990',
  '43100','43290','43510','44100','44990','45990',
  '61050','62000','63000','64000','65000','66000','69990'];

let outputRows;
if (fileType === 'actuals' || fileType === 'budget') {
  const filtered = rows.filter(row => {
    const gl = String(Object.values(row)[0] || '').trim();
    return keyGLCodes.includes(gl) || gl.endsWith('990') || gl.endsWith('000');
  });
  outputRows = filtered.length > 0 ? filtered : rows.slice(0, 100);
} else {
  outputRows = rows.slice(0, 200);
}

return [{
  json: {
    output: JSON.stringify({ success: true, fileType, rowCount: outputRows.length, data: outputRows })
  }
}];
```

### Key Lessons Learned (read before modifying this workflow)

1. **n8n field names are case-sensitive.** Always match the exact
   casing defined in the trigger's Workflow Input Schema.
2. **ToolWorkflow v2 requires the final node to return a field
   literally named `output`, as a STRING** (use JSON.stringify).
   Returning a raw JSON object causes "workflow did not return
   a response" errors.
3. **"Always Output Data" must be enabled on every node in the
   chain** (Search, Match File, Download, Extract, Code) to
   prevent the workflow from silently halting when zero items
   are found upstream — without it, n8n stops execution and
   returns nothing rather than a graceful error.
4. **Large P&L files exceed LLM context limits.** The full GL
   detail file is ~217K tokens — over Claude's 200K limit. The
   Code node filters to only key GL codes and subtotal rows
   (ending in 990/000) before returning data to Bessie.
5. **The old "Filter" node approach was abandoned** in favour of
   an explicit Code node (Match File) + IF node branch, because
   Filter node's "Kept: 0 items" behaviour didn't propagate
   useful data downstream for the false case.





