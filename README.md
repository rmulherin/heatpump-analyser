# Heat Pump Analyser

**"Should I install a heat pump?"** — answered with your own smart meter data.

A client-side web tool that takes household energy consumption data and produces
a detailed financial analysis of heat pump installation scenarios. All
processing runs in the browser. Your data never leaves your machine.

**Live tool:** [rmulherin.github.io/heatpump-analyser](https://rmulherin.github.io/heatpump-analyser)

---

## What It Does

1. **Ingests** your half-hourly gas and electricity data (via Octopus Energy API
   or CSV upload)
2. **Fetches** local weather data and wholesale electricity prices
3. **Analyses** your home's heat loss, thermal mass, and heating patterns
4. **Simulates** six scenarios: current boiler, dumb/smart heat pump on
   SVT/wholesale pricing, and hybrid systems
5. **Compares** annual costs and calculates payback periods

## Tech Stack

- HTML + vanilla JavaScript (no framework, no build step)
- Chart.js for visualisation
- Hosted on GitHub Pages
- Client-side only — no server

## External APIs

| API | Purpose | Auth |
|-----|---------|------|
| Octopus Energy | Consumption data + tariff rates | User's API key (Basic Auth) |
| Postcodes.io | Postcode → lat/lon | None |
| Open-Meteo | Historical temperature + solar radiation | None |
| Elexon Insights | Half-hourly wholesale electricity prices | None |

## File Structure

```
heatpump-analyser/
├── index.html              ← entry point
├── css/
│   └── styles.css
├── js/
│   ├── app.js              ← orchestration, Chart.js rendering, and UI wiring
│   ├── constants.js        ← shared cross-module constants (HDD/CDD base temps)
│   ├── data-ingestion.js   ← Octopus API + CSV parser
│   ├── external-data.js    ← weather + wholesale prices
│   ├── baseload.js         ← heating/hot water/cooking separation
│   ├── heat-loss.js        ← Siviour regression (HTC)
│   ├── thermal-character.js ← setpoint, thermal mass, time constant, occupancy weights
│   ├── scenario-consumption.js ← RC model + greedy LP optimiser + scenario arrays
│   ├── heatpump-model.js   ← COP curves + HP sizing
│   ├── pricing-engine.js   ← 6-scenario cost calculation
│   └── financial.js        ← payback + sensitivity analysis
├── docs/
│   └── plans/              ← Claude Code implementation plans
├── CLAUDE.md               ← Claude Code operational rules
└── README.md               ← this file
```

## Development

No build step. Open `index.html` in a browser.

Design documents, architecture, and scope live in a separate repo:
`praxis-claude-hub/projects/tools/heatpump-analyser/`

## Privacy

- All data processed locally in your browser
- API keys stored in memory only (not persisted)
- No analytics, tracking, or telemetry
- No server-side processing

## Author

Rhiannon Mulherin — [Praxis Insight](https://praxis-insight.com)
