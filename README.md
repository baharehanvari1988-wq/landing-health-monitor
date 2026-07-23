# Landing Health Monitor

Daily job: reads a PostHog Trends insight (with 3 formulas: %Starter, %ODP, %Paid) →
classifies each green/yellow/red → alerts Slack only on change → keeps a CSV history.

## Why this approach (not a Funnel)

We started with a PostHog Funnel, but discovered the landing page (`studioverse.io`)
and the app (`app.studioverse.io`) don't share a linked user identity — so a funnel
could never connect "saw the landing page" to "completed an order." Instead we use
independent Trends series (raw counts) combined with Formula mode, which sidesteps
the identity problem entirely: it just divides two counts from the same time window.

## Current status

- Live: `%Starter`, `%ODP`, `%Paid` in one PostHog insight
- Not done yet: Bounce rate — add it as a 4th formula later, then add
  `bounce` back into `KPI_CONFIG` in `monitor.js`
- Not done yet: filtering out internal/artist accounts (team members testing the
  order flow). This inflates %ODP and %Paid right now. Add their emails as filters
  in the PostHog insight (Filters -> + Filter -> Email address -> doesn't contain)
  once you have the full list.

## Setup — do these in order

### 1. Confirm the PostHog insight
Already built: "Landing Health Monitor — Trend %", project ID 216470,
short_id dr8xNHbK. It has 4 raw series (Pageview, cta_order_finish,
client_returned_to_odp, cta_order_step_complete — all "Unique users") plus 3
formulas: B/A*100 -> %Starter, C/B*100 -> %ODP, D/C*100 -> %Paid.

If you rebuild this insight from scratch, the formula names must exactly match
what's in KPI_CONFIG in monitor.js (%Starter, %ODP, %Paid) — the script
looks up each series by that exact label.

### 2. Get a PostHog API key
Settings -> Personal API keys -> create one with read-only access to Insights.
This is POSTHOG_API_KEY. Project ID and host are already filled in .env.example.

### 3. Create a Slack webhook
Slack -> your workspace -> api.slack.com/apps -> create app -> Incoming Webhooks ->
add to the channel you want alerts in (e.g. #landing-health). Copy the URL -> SLACK_WEBHOOK_URL.

### 4. (Optional but recommended) healthchecks.io
Go to healthchecks.io, create a free check with a daily schedule.
Copy its ping URL -> HEALTHCHECK_URL. This tells you if the job itself ever fails to run —
separate from whether your KPIs are healthy.

### 5. Push this folder to a GitHub repo, then add secrets
Repo -> Settings -> Secrets and variables -> Actions -> New repository secret, add all values from
.env.example (using their real values, not the placeholders).

### 6. Test it manually
Go to the repo's Actions tab -> "Landing Health Daily Check" -> Run workflow.
Check the run logs, then check data/history.csv for a new row, and Slack if status wasn't green.

### 7. Let it run
The cron in .github/workflows/daily-check.yml runs it every day at 05:00 UTC. Adjust the cron
expression to match when you want the check to happen in your timezone.

## Follow-ups (don't lose track of these)

1. Filter out internal/artist accounts in the PostHog insight (inflates %ODP, %Paid right now)
2. Add Bounce rate as a 4th formula, then add bounce back into KPI_CONFIG
3. Ask the dev team to link identity across studioverse.io and app.studioverse.io
   (shared cookie domain .studioverse.io) — once fixed, a real Funnel becomes usable again

## Tuning thresholds or checklists
Edit KPI_CONFIG and CHECKLISTS at the top of monitor.js — no other code needs to change.

## Local testing
```bash
cp .env.example .env
# fill in real values, then:
node -r dotenv/config monitor.js
```
(Requires `npm install dotenv` for local testing only — not needed in GitHub Actions, where secrets
are injected as real env vars.)
