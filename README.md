# jira-hours

CLI to fetch your Jira worklogs and show daily totals with per-ticket breakdown.

## Setup

```bash
git clone https://github.com/hernaneche/jira-hours
cd jira-hours
npm install
```

Create a `.env` file:

```
JIRA_BASE_URL="https://yourcompany.atlassian.net"
JIRA_EMAIL="you@company.com"
JIRA_API_TOKEN="your-token"
```

Get your API token at https://id.atlassian.com/manage-profile/security/api-tokens

## Usage

```bash
node jh.js                              # current month
node jh.js month=03                     # March (current year)
node jh.js month=2026-01                # January 2026
node jh.js from=01 to=03               # January to March
node jh.js from=2026-01-15 to=2026-03-20  # exact dates
```

Date formats: `MM`, `YYYY-MM`, or `YYYY-MM-DD`.

## Output

```
Range: 2026-04-01 -> 2026-04-30

Wed 2026-04-01  0h 40m  [PROJ-123 (0h 25m), PROJ-456 (0h 15m)]
Thu 2026-04-02  2h 10m  [PROJ-789 (1h 30m), PROJ-456 (0h 40m)]

Total: 2h 50m (2 days)
```

## License

MIT
