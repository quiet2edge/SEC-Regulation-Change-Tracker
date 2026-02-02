# Apify Scheduler configuration guide (hourly / daily / weekly)

This actor is stateless at runtime but **stateful across runs** via the default Key-Value store (`STATE.json`).
That means you can schedule it as frequently as you like and it will only emit **new filings** and **amendments**
since the last successful run (plus any "updates" detected by fingerprint changes).

---

## 1) Create & deploy the Actor
1. Push this repository to GitHub.
2. In Apify Console: **Actors → Create new → From GitHub**.
3. Build the actor and run once manually to validate.

**Important:** SEC requests require a good `userAgent` string (e.g., `"Your Name your.email@domain.com"`).

---

## 2) Create an “Actor task” (recommended)
Using a task lets you store a stable input configuration (targets/forms/date options) and then schedule the task.

1. Open the Actor in Apify Console.
2. Click **Tasks → Create new task**.
3. Paste your preferred input (start from `input.example.json`).
4. Save the task.

Why tasks? You can maintain multiple configurations:
- “Daily – all tickers”
- “Hourly – priority tickers”
- “Weekly – broad watchlist with backfill off”

---

## 3) Scheduler options

### Option A — Apify built-in Schedule (UI)
1. Go to **Schedules** in Apify Console.
2. Create a new Schedule.
3. Choose what to run:
   - **Run a task** (preferred), OR
   - **Run an actor** (works but you must include input each time)
4. Pick frequency:
   - Hourly / Daily / Weekly (UI presets), OR
   - Advanced: Cron expression

Recommended cron examples:
- **Hourly (top of hour):** `0 * * * *`
- **Daily at 9:00 AM:** `0 9 * * *`
- **Weekly Monday 9:00 AM:** `0 9 * * 1`

---

### Option B — External scheduler + Apify API
If you want "near real-time" (e.g., every 5 minutes), you can trigger the actor via the Apify API from:
- GitHub Actions
- Cloudflare Cron Triggers
- AWS EventBridge / Lambda
- A simple server cron

Key point: each run will reuse the same KV store state and only emit changes.

---

## 4) Suggested run strategies

### Hourly
- Best for a small watchlist (e.g., 10–50 companies).
- Set:
  - `maxFilingsPerCompany` ~ 50–200
  - `requestConcurrency` ~ 2–4

### Daily
- Best for larger watchlists (100–500 companies depending on runtime).
- Keep `requestConcurrency` modest.

### Weekly
- Use for broad but low urgency.
- Consider enabling `backfill=false` so it only tracks forward.

---

## 5) “Real-time monitoring” product option
Apify doesn’t run continuously by default. In your UX you can offer:
- **Realtime** = schedule every 5–15 minutes (or use a webhook trigger when your own system detects a need)
- **Hourly/Daily/Weekly** = schedule using the built-in Scheduler

The actor already includes `checkFrequency` in input for your product layer.
Scheduling is controlled outside the actor.

---

## 6) Verify the scheduler is working
After the scheduled run:
- Dataset should contain rows for each detected change.
- Key-Value store contains:
  - `REPORT.md` and `REPORT.json`
  - `OUTPUT.csv` (if enabled)
  - `STATE.json` updated with `lastSuccessfulRunAt`

---

## 7) Common gotchas
- **Missing userAgent**: input schema requires it, and SEC expects it.
- **Too aggressive concurrency**: keep `requestConcurrency` low to be polite to EDGAR.
- **First run noise**:
  - If you want historical seeding: `backfill=true` (+ dateRange or backfillDays)
  - If you only want changes from “go-live”: `backfill=false` and leave dateRange empty
