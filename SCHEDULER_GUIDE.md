# Apify Scheduler Configuration Guide
This guide explains how to schedule the **SEC Regulation Change Monitor** Actor for
real-time, hourly, daily, or weekly monitoring.

> Important: Apify Actors do not run continuously. “Real-time” means **frequent scheduled runs**
(e.g., every 5 minutes) using the Apify Scheduler.

---

## Prerequisites
- Actor deployed in Apify Console
- Actor input saved (including required `userAgent`)
- Optional: secrets stored in **Actor → Settings → Secrets**
  - `OPENAI_API_KEY` (if AI summaries are enabled)

---

## Step-by-Step: Create a Schedule

1. Go to **Apify Console → Schedules**
2. Click **Create new schedule**
3. Choose **Run Actor**
4. Select your deployed Actor
5. Choose **Run with saved input**
6. Set the **cron / frequency** (examples below)
7. Save

---

## Recommended Frequencies

### “Real-Time” Monitoring (Near Real-Time)
Use this when you want rapid detection of new filings.

**Every 5 minutes**
```
*/5 * * * *
```

**Every 10 minutes**
```
*/10 * * * *
```

Recommended input:
```json
{
  "checkFrequency": "realtime"
}
```

---

### Hourly Monitoring
Runs once per hour, suitable for most compliance and alerting use cases.

**Every hour (on the hour)**
```
0 * * * *
```

Input:
```json
{
  "checkFrequency": "hourly"
}
```

---

### Daily Monitoring
Runs once per day.

**Every day at 7:00 AM UTC**
```
0 7 * * *
```

Input:
```json
{
  "checkFrequency": "daily"
}
```

---

### Weekly Monitoring
Runs once per week.

**Every Monday at 7:00 AM UTC**
```
0 7 * * 1
```

Input:
```json
{
  "checkFrequency": "weekly"
}
```

---

## Best Practices
- **Stateful tracking** is already handled by the Actor using the Apify Key-Value Store.
  - Only new filings and amendments since the last successful run are reported.
- Avoid running more frequently than needed for large company lists.
- SEC politely requests:
  - Clear `User-Agent`
  - Low request concurrency (default is safe)

---

## Alerting & Automation
Common next steps:
- Add a **Webhook** on the schedule to:
  - Slack
  - Email
  - Internal monitoring system
- Consume `REPORT.json` for dashboards or alerts
- Use `OUTPUT.csv` for downstream ingestion

---

## Example Production Setup
- Schedule: every 10 minutes
- Targets: 50–200 companies
- Backfill: false
- Output: JSON + CSV
- AI summaries: enabled only for amendments

---

If you want, I can also provide:
- Slack / email webhook payload examples
- A Terraform-style scheduler definition
- A “real-time alerting” mode that emits only high-risk changes
