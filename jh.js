#!/usr/bin/env node

import "dotenv/config";
import fetch from "node-fetch";
import { createInterface } from "node:readline";

const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;

const missing = [
  !JIRA_BASE_URL && "JIRA_BASE_URL",
  !JIRA_EMAIL && "JIRA_EMAIL",
  !JIRA_API_TOKEN && "JIRA_API_TOKEN",
].filter(Boolean);

if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const baseUrl = JIRA_BASE_URL.replace(/\/+$/, "");
const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

async function jira(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} -> ${res.status}: ${text}`);
  }

  return res.json();
}

async function getCurrentUser() {
  return jira("/rest/api/3/myself");
}

async function fetchIssues(nextPageToken = null, acc = []) {
  const body = {
    jql: "worklogAuthor = currentUser()",
    maxResults: 50,
    fields: ["key", "summary"],
  };

  if (nextPageToken) {
    body.nextPageToken = nextPageToken;
  }

  const data = await jira("/rest/api/3/search/jql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const issues = data.issues || [];
  acc.push(...issues);

  if (!data.isLast && data.nextPageToken) {
    return fetchIssues(data.nextPageToken, acc);
  }

  return acc;
}

async function fetchAllWorklogs(issueKey) {
  let startAt = 0;
  const all = [];

  while (true) {
    const data = await jira(
      `/rest/api/3/issue/${encodeURIComponent(
        issueKey
      )}/worklog?startAt=${startAt}&maxResults=100`
    );

    const logs = data.worklogs || [];
    all.push(...logs);

    if (startAt + logs.length >= (data.total || 0)) {
      break;
    }

    startAt += 100;
  }

  return all;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateUTC(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate()
  )}`;
}

function startOfCurrentMonthUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function endOfCurrentMonthUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
}

function getCurrentYearUTC() {
  return new Date().getUTCFullYear();
}

function daysInMonthUTC(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^([^=]+)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  return out;
}

function parseMonthLike(spec, fallbackYear) {
  if (!spec) return null;

  if (/^\d{2}$/.test(spec)) {
    const month = Number(spec);
    if (month < 1 || month > 12) {
      throw new Error(`Invalid month "${spec}". Use 01..12`);
    }
    return { year: fallbackYear, month };
  }

  if (/^\d{4}-\d{2}$/.test(spec)) {
    const [year, month] = spec.split("-").map(Number);
    if (month < 1 || month > 12) {
      throw new Error(`Invalid month "${spec}". Use YYYY-MM`);
    }
    return { year, month };
  }

  return null;
}

function parseDateLike(spec, kind, fallbackYear) {
  if (!spec) return null;

  const monthLike = parseMonthLike(spec, fallbackYear);
  if (monthLike) {
    if (kind === "from") {
      return new Date(Date.UTC(monthLike.year, monthLike.month - 1, 1));
    }
    if (kind === "to") {
      return new Date(
        Date.UTC(
          monthLike.year,
          monthLike.month - 1,
          daysInMonthUTC(monthLike.year, monthLike.month)
        )
      );
    }
    if (kind === "monthFrom") {
      return new Date(Date.UTC(monthLike.year, monthLike.month - 1, 1));
    }
    if (kind === "monthTo") {
      return new Date(
        Date.UTC(
          monthLike.year,
          monthLike.month - 1,
          daysInMonthUTC(monthLike.year, monthLike.month)
        )
      );
    }
    throw new Error(`Unknown kind "${kind}"`);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
    const [y, m, d] = spec.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  throw new Error(
    `Invalid ${kind}= value "${spec}". Use MM, YYYY-MM, or YYYY-MM-DD`
  );
}

function resolveDateRange(argv) {
  const args = parseArgs(argv);
  const currentYear = getCurrentYearUTC();

  if (args.month) {
    const from = parseDateLike(args.month, "monthFrom", currentYear);
    const to = parseDateLike(args.month, "monthTo", currentYear);

    return {
      from,
      to,
      fromStr: formatDateUTC(from),
      toStr: formatDateUTC(to),
    };
  }

  const hasAnyParams = Object.keys(args).length > 0;

  if (!hasAnyParams) {
    const from = startOfCurrentMonthUTC();
    const to = endOfCurrentMonthUTC();

    return {
      from,
      to,
      fromStr: formatDateUTC(from),
      toStr: formatDateUTC(to),
    };
  }

  let inferredYearForFrom = currentYear;
  let inferredYearForTo = currentYear;

  const fromYear =
    args.from && /^\d{4}-\d{2}$/.test(args.from)
      ? Number(args.from.slice(0, 4))
      : null;

  const toYear =
    args.to && /^\d{4}-\d{2}$/.test(args.to)
      ? Number(args.to.slice(0, 4))
      : null;

  if (fromYear && args.to && /^\d{2}$/.test(args.to)) {
    inferredYearForTo = fromYear;
  }

  if (toYear && args.from && /^\d{2}$/.test(args.from)) {
    inferredYearForFrom = toYear;
  }

  const from =
    parseDateLike(args.from, "from", inferredYearForFrom) ||
    startOfCurrentMonthUTC();

  const to =
    parseDateLike(args.to, "to", inferredYearForTo) || endOfCurrentMonthUTC();

  if (from > to) {
    throw new Error(
      `Invalid range: from (${formatDateUTC(
        from
      )}) is after to (${formatDateUTC(to)})`
    );
  }

  return {
    from,
    to,
    fromStr: formatDateUTC(from),
    toStr: formatDateUTC(to),
  };
}

function formatTotal(hoursDecimal) {
  const totalMinutes = Math.round(hoursDecimal * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatTicket(hoursDecimal) {
  const totalMinutes = Math.round(hoursDecimal * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function getDayName(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "UTC",
  }).format(date);
}

function isDateInRange(dateStr, range) {
  return dateStr >= range.fromStr && dateStr <= range.toStr;
}

async function aggregate(range) {
  const me = await getCurrentUser();
  const myAccountId = me.accountId;

  if (!myAccountId) {
    throw new Error("Could not determine current user's accountId");
  }

  const issues = await fetchIssues();

  // date -> { total: number, issues: Map(issueKey -> { hours, summary }) }
  const map = new Map();

  for (const issue of issues) {
    const summary = (issue.fields?.summary || "").replace(/[\r\n]+/g, " ").trim();
    const logs = await fetchAllWorklogs(issue.key);

    for (const log of logs) {
      if (log.author?.accountId !== myAccountId) continue;

      const date = String(log.started).slice(0, 10);

      if (!isDateInRange(date, range)) continue;

      const hours = (log.timeSpentSeconds || 0) / 3600;

      if (!map.has(date)) {
        map.set(date, {
          total: 0,
          issues: new Map(),
        });
      }

      const entry = map.get(date);
      entry.total += hours;

      const prev = entry.issues.get(issue.key);
      entry.issues.set(issue.key, {
        hours: (prev?.hours || 0) + hours,
        summary,
      });
    }
  }

  return map;
}

function allDaysInRange(range) {
  const today = formatDateUTC(new Date());
  const days = [];
  const d = new Date(range.from);
  while (d <= range.to) {
    const str = formatDateUTC(d);
    if (str > today) break;
    days.push(str);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function print(map, range, full, sumTicket) {
  console.log(`Range: ${range.fromStr} -> ${range.toStr}`);

  const allDays = allDaysInRange(range);

  let grandTotal = 0;
  let sumTicketTotal = 0;
  let workedDays = 0;

  for (const date of allDays) {
    const dayName = getDayName(date);
    const data = map.get(date);

    if (!data) {
      if (!isWeekend(date)) {
        console.log(`${dayName} ${date}  -`);
      }
      continue;
    }

    grandTotal += data.total;
    workedDays++;

    if (sumTicket) {
      const entry = data.issues.get(sumTicket);
      if (entry) sumTicketTotal += entry.hours;
    }

    const issuesSorted = [...data.issues.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );

    if (full) {
      console.log(`\n${dayName} ${date}  ${formatTotal(data.total)}`);
      for (const [issueKey, { hours, summary }] of issuesSorted) {
        console.log(`  ${issueKey}  ${formatTicket(hours)}  ${summary}`);
      }
    } else {
      const issuesText = issuesSorted
        .map(([issueKey, { hours }]) => `${issueKey} ${formatTicket(hours)}`)
        .join(" | ");

      console.log(`${dayName} ${date}  ${formatTotal(data.total)}  | ${issuesText}`);
    }
  }

  const dayWord = workedDays === 1 ? "day" : "days";
  const avg = workedDays > 0 ? formatTotal(grandTotal / workedDays) : "0h 00m";
  console.log(`\nTotal: ${formatTotal(grandTotal)} (${workedDays} ${dayWord}, avg ${avg}/day)`);

  if (sumTicket) {
    const rest = grandTotal - sumTicketTotal;
    const pct = (n) =>
      grandTotal > 0 ? ` (${((n / grandTotal) * 100).toFixed(1)}%)` : "";
    console.log(`  ${sumTicket}: ${formatTotal(sumTicketTotal)}${pct(sumTicketTotal)}`);
    console.log(`  rest:  ${formatTotal(rest)}${pct(rest)}`);
  }
}

function parseDuration(spec) {
  const m = spec.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/i);
  if (!m || (!m[1] && !m[2])) {
    throw new Error(`Invalid duration "${spec}". Use formats like 1h30m, 45m, 2h`);
  }
  const hours = Number(m[1] || 0);
  const minutes = Number(m[2] || 0);
  const seconds = hours * 3600 + minutes * 60;
  if (seconds <= 0) throw new Error(`Duration must be > 0`);
  return seconds;
}

function parseLogDate(spec) {
  if (spec === "today") return formatDateUTC(new Date());
  if (spec === "yesterday") {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return formatDateUTC(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  throw new Error(`Invalid date "${spec}". Use YYYY-MM-DD, today, or yesterday`);
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function logWork(args) {
  const [issueKey, durationSpec, dateSpec, ...commentParts] = args;

  if (!issueKey || !durationSpec) {
    throw new Error("Usage: node jh.js log <TICKET> <DURATION> [DATE] [comment]");
  }

  const seconds = parseDuration(durationSpec);
  const date = parseLogDate(dateSpec || "today");
  const comment = commentParts.join(" ");

  const issue = await jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary`);
  const summary = issue.fields?.summary || "(no title)";

  const hoursDecimal = seconds / 3600;
  console.log(`${issueKey}  "${summary}"`);
  const promptMsg = `Log ${formatTotal(hoursDecimal)} on ${date}${comment ? ` (${comment})` : ""}? [yes/N]: `;
  const answer = (await prompt(promptMsg)).trim().toLowerCase();

  if (answer !== "yes") {
    console.log("Cancelled.");
    return;
  }

  const body = {
    timeSpentSeconds: seconds,
    started: `${date}T09:00:00.000+0000`,
  };

  if (comment) {
    body.comment = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
    };
  }

  await jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  console.log("Logged.");
}

(async () => {
  try {
    const argv = process.argv.slice(2);

    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(`Usage:
  node jh.js                                    # current month
  node jh.js month=MM                           # e.g. month=03
  node jh.js month=YYYY-MM                      # e.g. month=2026-01
  node jh.js from=<date> to=<date>              # range (MM, YYYY-MM, YYYY-MM-DD)
  node jh.js [...] --full                       # per-ticket details with titles
  node jh.js [...] --sum=TICKET                 # subtotal for TICKET vs rest

  node jh.js log|add <TICKET> <DURATION> [DATE] [comment]
    DURATION: 1h30m, 45m, 2h
    DATE:     YYYY-MM-DD, today, yesterday (default: today)`);
      return;
    }

    if (argv[0] === "log" || argv[0] === "add") {
      await logWork(argv.slice(1));
      return;
    }

    const full = argv.includes("--full");
    const sumArg = argv.find((a) => a.startsWith("--sum="));
    const sumTicket = sumArg ? sumArg.slice("--sum=".length) : null;
    const filtered = argv.filter(
      (a) => a !== "--full" && !a.startsWith("--sum=")
    );
    const range = resolveDateRange(filtered);
    const map = await aggregate(range);
    print(map, range, full, sumTicket);
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
})();
