# forecastData Schema v2

**Version:** 2.0  
**Last Updated:** 2026-06-25  
**Used by:** Tool 5 (Generate Excel) Code node  
**Produced by:** The forecasting agent after analyzing Tool 4 outputs

---

## Overview

`forecastData` is the JSON payload the forecasting agent constructs and passes to Tool 5.
It contains everything needed to produce the v4 Excel workbook: actuals, three scenario
forecasts, assumptions, prior-year data, rent roll KPIs, and key findings.

Tool 5 passes this as a string (`forecastData` input field). Tool 5 parses it with
`JSON.parse()` and uses it to populate all five workbook tabs.

---

## Full Schema

```json
{
  "property": "string — property code, e.g. prop01",
  "period": "string — forecast period label, e.g. 2026-Q3",
  "fiscalYear": "string — e.g. FY2026",
  "generatedAt": "string — ISO 8601 timestamp",

  "dataQuality": {
    "hasPriorYearActuals": "boolean",
    "hasPriorYearBudget": "boolean",
    "hasPriorYearRentRoll": "boolean",
    "actualsMonthsAvailable": "number — typically 9 at Q3",
    "warningFlags": ["array of string warning messages, empty if none"]
  },

  "actuals": [
    {
      "gl_code": "string — e.g. 41100",
      "account_name": "string",
      "category": "string — Revenue | Labor | Admin | R&M | Utilities | Realty Tax | Mgmt Fee",
      "Jul-25": "number",
      "Aug-25": "number",
      "Sep-25": "number",
      "Oct-25": "number",
      "Nov-25": "number",
      "Dec-25": "number",
      "Jan-26": "number",
      "Feb-26": "number",
      "Mar-26": "number",
      "ytd_total": "number — sum of all 9 actual months",
      "original_budget": "number — full year original budget from source col 15"
    }
  ],

  "baseline": [
    {
      "gl_code": "string",
      "account_name": "string",
      "category": "string",
      "Apr-26": "number — baseline forecast for April",
      "May-26": "number — baseline forecast for May",
      "Jun-26": "number — baseline forecast for June",
      "forecast_total": "number — sum of Apr+May+Jun",
      "adj_pct": "number — decimal, e.g. 0.005 = +0.5%",
      "basis": "string — rationale for this GL's forecast"
    }
  ],

  "upside": [ "same structure as baseline" ],

  "downside": [ "same structure as baseline" ],

  "variance": [
    {
      "gl_code": "string",
      "account_name": "string",
      "category": "string",
      "budget_annual": "number — full year original budget",
      "ytd_actuals": "number — 9-month actual total",
      "forecast_q3_baseline": "number — baseline Apr+May+Jun total",
      "total_forecast": "number — ytd_actuals + forecast_q3_baseline",
      "var_dollar": "number — total_forecast minus budget_annual",
      "var_pct": "number — var_dollar / abs(budget_annual)",
      "flag": "string — FAV | UNFA | NEUTRAL"
    }
  ],

  "assumptions": [
    {
      "gl_code": "string",
      "account_name": "string",
      "category": "string",
      "scenario": "string — Baseline | Upside | Downside",
      "adj_pct": "number — decimal adjustment applied to trailing avg",
      "basis": "string — rationale for this scenario adjustment",
      "source": "string — data source for this assumption"
    }
  ],

  "pyActuals": [
    {
      "gl_code": "string",
      "account_name": "string",
      "category": "string",
      "fy2025_total": "number — full FY2025 annual total from prior-year file col 14",
      "yoy_dollar": "number — CY total_forecast minus fy2025_total",
      "yoy_pct": "number — yoy_dollar / abs(fy2025_total)"
    }
  ],

  "rentRoll": {
    "asOfDate": "string — YYYY-MM-DD",
    "totalUnits": "number",
    "occupiedUnits": "number",
    "vacantUnits": "number",
    "occupancyRate": "number — decimal, e.g. 0.9767",
    "portfolioMarketRent": "number — monthly total at market",
    "portfolioInPlaceRent": "number — monthly total in-place",
    "lossToLease": "number — monthly $ gap",
    "lossToLeasePct": "number — lossToLease / portfolioMarketRent"
  },

  "keyFindings": {
    "ytdRevenue": "number",
    "ytdOpEx": "number",
    "ytdNOI": "number",
    "ytdNOIMargin": "number — decimal",
    "fullYearRevenueBaseline": "number — ytd + baseline Q3 forecast",
    "fullYearOpExBaseline": "number",
    "fullYearNOIBaseline": "number",
    "budgetVarianceDollar": "number — fullYearRevenue minus budget",
    "budgetVariancePct": "number — decimal",
    "yoyRevenueDollar": "number — null if PY not available",
    "yoyRevenuePct": "number — null if PY not available",
    "topFavourableVariances": [
      {
        "gl": "string",
        "account": "string",
        "var_dollar": "number",
        "var_pct": "number"
      }
    ],
    "topUnfavourableVariances": [ "same structure" ]
  }
}
```

---

## Change Log vs v1

| Field | Change | Reason |
|---|---|---|
| `pyActuals[]` | **NEW** | Populates `_PY_Data` tab; enables YOY columns P/Q/R on Forecast tab |
| `rentRoll{}` | **NEW** | Populates Key Findings occupancy section |
| `keyFindings{}` | **NEW** | Populates Key Findings KPI section; avoids recomputation in Tool 5 |
| `dataQuality{}` | **NEW** | Lets Tool 5 flag incomplete data to the user |
| `baseline[].adj_pct` | **NEW** | Required for Assumptions tab — shows the % used |
| `baseline[].basis` | **NEW** | Required for Assumptions tab comments column |
| `actuals[].ytd_total` | **NEW** | Precomputed sum, avoids Tool 5 recomputation |
| `actuals[].original_budget` | **NEW** | Required for variance calculations |
| `upside`, `downside` | **Unchanged structure** | Same as baseline array |
| `property`, `period` | **Unchanged** | Same as v1 |

---

## Workbook Tab Mapping

| forecastData field | Workbook tab | Column(s) |
|---|---|---|
| `actuals[]` | Forecast | C–K (Jul–Mar) |
| `baseline[]` | Forecast | L/M/N when scenario = Baseline |
| `upside[]` | Forecast | L/M/N when scenario = Upside |
| `downside[]` | Forecast | L/M/N when scenario = Downside |
| `variance[]` | Forecast | O, S, T, U |
| `assumptions[]` | Assumptions | E, F, G, H, I, J |
| `pyActuals[]` | _PY_Data | Column O (row 12+) |
| `rentRoll{}` | Key Findings | Occupancy & Rent Roll section |
| `keyFindings{}` | Key Findings | All KPI sections |

---

## Key Rules for the Forecasting Agent

1. **Never include cols 11–13 in actuals.** Col 8/9/10 = Jan/Feb/Mar actual. Col 11/12/13 = budget.

2. **adj_pct in baseline/upside/downside is the multiplier applied to trailing avg:**
   - `forecast_value = trailing_3m_avg × (1 + adj_pct)`
   - For negative lines (vacancy, free rent): same formula applies. A negative adj_pct makes the absolute value smaller (improvement). A positive adj_pct makes it larger (deterioration).

3. **pyActuals[] uses col 14 (O = Total) from the prior-year file** — the full-year annual total, not monthly data.

4. **dataQuality.warningFlags** should include any of:
   - "PY actuals not found — YOY section will be blank"
   - "Rent roll not found — occupancy section uses estimates"
   - "Budget file not found — variance section will be blank"
   - "Only X months of actuals available — trailing avg based on fewer months"

5. **Assumptions should include one row per GL per scenario** (3 rows per GL = Baseline + Upside + Downside).

