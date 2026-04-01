#!/usr/bin/env node

import "dotenv/config";
import fetch from "node-fetch";

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
    fields: ["key"],
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

function formatHM(hoursDecimal) {
  const totalMinutes = Math.round(hoursDecimal * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
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

  // date -> { total: number, issues: Map(issueKey -> number) }
  const map = new Map();

  for (const issue of issues) {
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
      entry.issues.set(issue.key, (entry.issues.get(issue.key) || 0) + hours);
    }
  }

  return map;
}

function print(map, range) {
  console.log(`Range: ${range.fromStr} -> ${range.toStr}`);

  const sortedDates = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));

  if (sortedDates.length === 0) {
    console.log("No worklogs found in this range.");
    return;
  }

  let grandTotal = 0;

  for (const [date, data] of sortedDates) {
    const dayName = getDayName(date);
    grandTotal += data.total;

    const issuesSorted = [...data.issues.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );

    const issuesText = issuesSorted
      .map(([issueKey, hours]) => `${issueKey} ${formatHM(hours)}`)
      .join(", ");

    console.log(`${dayName} ${date}  ${formatHM(data.total)}  [${issuesText}]`);
  }

  console.log(`\nTotal: ${formatHM(grandTotal)} (${sortedDates.length} days)`);
}

(async () => {
  try {
    const range = resolveDateRange(process.argv.slice(2));
    const map = await aggregate(range);
    print(map, range);
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
})();
