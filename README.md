# SEC Regulation Change Monitor (Apify Actor)

This actor monitors **new SEC EDGAR filings** and **amendments** for a configurable list of companies (by **ticker** and/or **CIK**) and produces:
- A dataset of detected changes (new filings + amendments)
- A **summary report** (JSON + markdown)
- Optional **CSV export** alongside JSON

Supported forms (default): `S-1, S-3, S-4, 10-Q, 10-K, 8-K, DEF 14A, 13D, 13G, ADV, D (Form D)`  
(You can override the form list via input.)

## What counts as a “change”?
- **New filing** since the last successful run (tracked in persistent state)
- **Amendment** filing (e.g., `10-K/A`, `S-1/A`) since the last run
- Optional: If you set a date range, filings are filtered to that range (and can backfill history)

## Scheduling / “real-time”
Apify Actors execute when triggered. To offer “real-time / hourly / daily / weekly”, expose `checkFrequency` in input and configure **Apify Scheduler** (or webhooks) to run this actor at your desired cadence.

## Rate limits & SEC headers
The SEC asks automated clients to identify themselves with a clear User-Agent string and to limit request rates.
Set `userAgent` in input (example: `YourName your.email@domain.com`).

## Outputs
- **Dataset items**: one row per detected filing (with basic enrichment and parsed sections when available)
- **Key-Value store**:
  - `REPORT.json` – summary stats + lists
  - `REPORT.md` – human-friendly summary
  - `OUTPUT.csv` – CSV export (if enabled)

## Local test
```bash
npm i
apify run
```

## Notes / limitations
- Parsing “Risk Factors” and “Financial Statements” is heuristic. EDGAR formatting varies by filer.
- “Amendment diffs” compare a current `/A` filing against the most recent prior non-`/A` filing of the same base form when available.
- AI summaries are optional. If `openaiApiKey` is absent, the actor falls back to a lightweight heuristic summary.

---

### Example input
See `INPUT_SCHEMA.json` for full docs.

