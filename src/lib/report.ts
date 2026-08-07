/**
 * Periodic stability reports.
 *
 * Every incident we notify about answers "what is broken right now". None
 * of them answers "which of our services is actually reliable" — that only
 * emerges from counting over time. This module produces one card per
 * period summarising how many outages each provider had.
 *
 * Three cadences, each fired at most once per period:
 *   weekly    — ISO week, e.g. 2026-W32
 *   monthly   — calendar month, e.g. 2026-08
 *   quarterly — calendar quarter, e.g. 2026-Q3
 *
 * A period is identified by a *label*, and the label of the last report
 * sent is persisted in the metadata table. When the current label differs
 * from the stored one, the previous period has ended and gets reported.
 * That makes the trigger idempotent across restarts and missed polls: a
 * container that was down all Monday still sends the weekly report on
 * Tuesday, and never sends the same one twice.
 */

import type { ProviderConfig } from "./config.js";
import type { Messages } from "./i18n.js";
import { formatDuration } from "./healthTracker.js";
import {
  getIncidentsBetween,
  getLastIncidentPerProvider,
  getMetadata,
  getProviderHealth,
  setMetadata,
  type Store,
} from "../state/store.js";

export const REPORT_PERIODS = ["weekly", "monthly", "quarterly"] as const;

export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** Per-provider tally within the reporting window. */
export type ProviderStat = {
  providerKey: string;
  displayName: string;
  /** Incidents that started within the window. */
  incidentCount: number;
  /** Of those, how many are still open at report time. */
  openCount: number;
  /**
   * Summed outage time of the **resolved** incidents, in milliseconds.
   * `null` when none of them closed within the window.
   *
   * Only resolved incidents count. An open one has no end yet, and
   * measuring it to the edge of the window turned a single forgotten
   * incident into "34d" inside a 31-day month. Note this is still a sum
   * over possibly overlapping outages, so it can exceed wall-clock time —
   * the label says "gesamt" to make that explicit.
   */
  downtimeMs: number | null;
};

/**
 * A provider that has never produced a single card since we started
 * watching it.
 *
 * Silence is ambiguous, and the ambiguity is the point of this list: a
 * genuinely reliable service looks exactly like a broken adapter. The two
 * are told apart by `upstreamCount` — how many incidents the provider's
 * own page returned on the last poll, before our filters:
 *
 *   - `0`   — the page itself reports nothing. The silence is real.
 *   - `> 0` — the page is busy but nothing reaches us. Either the filter
 *             is too narrow or the adapter is broken. Worth a look.
 *   - null  — the adapter does not report a count; undecidable.
 */
export type SilentProvider = {
  providerKey: string;
  displayName: string;
  /** Days since this provider was first polled. */
  observedDays: number;
  /** Incidents on the provider's own page at the last poll, before filters. */
  upstreamCount: number | null;
};

export type StatusReport = {
  period: ReportPeriod;
  /** Label of the period being reported, e.g. "2026-W31". */
  label: string;
  /** Window boundaries as ISO strings; `from` inclusive, `to` exclusive. */
  from: string;
  to: string;
  totalIncidents: number;
  /** Providers configured at report time. */
  providersTotal: number;
  /** Providers that had at least one incident. */
  providersAffected: number;
  /** Ranked worst-first; only providers with at least one incident. */
  byProvider: ProviderStat[];
  /**
   * Providers that have never reported anything, ever — not just in this
   * window. Longest-observed first, so the most suspicious entry leads.
   */
  silent: SilentProvider[];
};

/** Metadata key holding the label of the last report sent for a period. */
export function metadataKeyFor(period: ReportPeriod): string {
  return `report_last_${period}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * ISO-8601 week number. Weeks start on Monday and week 1 is the one
 * containing the first Thursday of the year — the same definition Swiss
 * and EU calendars use, so "week 32" means what the operator expects.
 */
export function isoWeek(date: Date): { year: number; week: number } {
  // Shift to the Thursday of the current week; its year is the ISO year.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: isoYear, week };
}

/** Label identifying the period `date` falls into. */
export function periodLabel(period: ReportPeriod, date: Date): string {
  switch (period) {
    case "weekly": {
      const { year, week } = isoWeek(date);
      return `${year}-W${pad(week)}`;
    }
    case "monthly":
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
    case "quarterly":
      return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  }
}

/**
 * Start (inclusive) and end (exclusive) of the period `date` falls into,
 * as UTC ISO strings.
 */
export function periodBounds(period: ReportPeriod, date: Date): { from: string; to: string } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  switch (period) {
    case "weekly": {
      const dayNumber = (date.getUTCDay() + 6) % 7; // Monday = 0
      const monday = new Date(Date.UTC(y, m, date.getUTCDate() - dayNumber));
      const next = new Date(monday.getTime() + 7 * 86_400_000);
      return { from: monday.toISOString(), to: next.toISOString() };
    }
    case "monthly":
      return {
        from: new Date(Date.UTC(y, m, 1)).toISOString(),
        to: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
      };
    case "quarterly": {
      const startMonth = Math.floor(m / 3) * 3;
      return {
        from: new Date(Date.UTC(y, startMonth, 1)).toISOString(),
        to: new Date(Date.UTC(y, startMonth + 3, 1)).toISOString(),
      };
    }
  }
}

/** The period immediately before the one containing `date`. */
function previousPeriodDate(period: ReportPeriod, date: Date): Date {
  const { from } = periodBounds(period, date);
  // One millisecond before this period started lies in the previous one.
  return new Date(new Date(from).getTime() - 1);
}

/**
 * Builds the report for the period that has just ended.
 *
 * `byProvider` lists **every configured provider**, including those with
 * no incident at all. The question the report exists to answer — "which of
 * our services is actually reliable" — is only answerable when the quiet
 * ones are named too; a ranking of the affected alone shows the problems
 * but never the track record.
 */
export function buildReport(
  store: Store,
  providers: ProviderConfig[],
  period: ReportPeriod,
  now: Date,
): StatusReport {
  const previous = previousPeriodDate(period, now);
  const label = periodLabel(period, previous);
  const { from, to } = periodBounds(period, previous);

  const rows = getIncidentsBetween(store, from, to);

  const nameByKey = new Map(providers.map((p) => [p.key, p.displayName]));
  const stats = new Map<string, ProviderStat>();

  for (const row of rows) {
    let stat = stats.get(row.providerKey);
    if (!stat) {
      stat = {
        providerKey: row.providerKey,
        // A provider removed from the config since the incident still has
        // history worth showing; fall back to its key.
        displayName: nameByKey.get(row.providerKey) ?? row.providerKey,
        incidentCount: 0,
        openCount: 0,
        downtimeMs: null,
      };
      stats.set(row.providerKey, stat);
    }
    stat.incidentCount++;
    if (row.status === "open") {
      stat.openCount++;
      continue; // No end yet — see ProviderStat.downtimeMs.
    }

    const started = new Date(row.startedAt).getTime();
    const ended = new Date(row.updatedAt).getTime();
    // Guard against unparseable or inverted timestamps rather than
    // poisoning the sum with NaN.
    if (Number.isFinite(started) && Number.isFinite(ended) && ended > started) {
      stat.downtimeMs = (stat.downtimeMs ?? 0) + (ended - started);
    }
  }

  // Configured providers that had no incident still belong in the report.
  for (const provider of providers) {
    if (stats.has(provider.key)) continue;
    stats.set(provider.key, {
      providerKey: provider.key,
      displayName: provider.displayName,
      incidentCount: 0,
      openCount: 0,
      downtimeMs: null,
    });
  }

  const byProvider = [...stats.values()].sort(
    (a, b) =>
      b.incidentCount - a.incidentCount ||
      (b.downtimeMs ?? 0) - (a.downtimeMs ?? 0) ||
      // Stable, readable order among the many zero-incident providers.
      a.displayName.localeCompare(b.displayName, "de"),
  );

  return {
    period,
    label,
    from,
    to,
    totalIncidents: rows.length,
    providersTotal: providers.length,
    // Counts only those that actually had something — byProvider now holds
    // every configured provider, including the quiet ones.
    providersAffected: byProvider.filter((p) => p.incidentCount > 0).length,
    byProvider,
    silent: findSilentProviders(store, providers, now),
  };
}

/**
 * Minimum observation time before a silent provider is worth mentioning.
 * Below this, silence says nothing — a service simply may not have broken
 * yet, and a freshly added provider would otherwise be flagged on day one.
 */
export const SILENT_MIN_DAYS = 14;

/**
 * Providers that never produced a card across the entire history.
 *
 * Deliberately not an alert: this is a list to read, not a page to answer.
 * The half-dead alert fires only on a proven config drift, precisely
 * because silence alone is not evidence of a defect — but "nobody has
 * heard from this source in 40 days" is still worth stating out loud once
 * a period, which is what this does.
 */
export function findSilentProviders(
  store: Store,
  providers: ProviderConfig[],
  now: Date,
): SilentProvider[] {
  const lastIncident = getLastIncidentPerProvider(store);
  const health = getProviderHealth(store);

  const silent: SilentProvider[] = [];
  for (const provider of providers) {
    if (lastIncident.has(provider.key)) continue;

    const row = health.get(provider.key);
    // Never polled successfully — the health tracker owns that case and
    // will have raised a "down" alert; do not double-report it here.
    if (!row) continue;

    const observedDays = Math.floor(
      (now.getTime() - new Date(row.firstSeenAt).getTime()) / 86_400_000,
    );
    if (!Number.isFinite(observedDays) || observedDays < SILENT_MIN_DAYS) continue;

    silent.push({
      providerKey: provider.key,
      displayName: provider.displayName,
      observedDays,
      upstreamCount: row.lastUpstreamCount,
    });
  }

  return silent.sort((a, b) => b.observedDays - a.observedDays);
}

/**
 * Decides which reports are due and marks them as sent.
 *
 * On first run nothing is due: the current labels are recorded so the
 * first real report covers a period we actually observed in full. Without
 * that seeding a fresh container would immediately emit three reports
 * about windows it has no data for.
 *
 * The metadata write happens here rather than after a successful send, so
 * a failing webhook cannot make the same report retry every five minutes.
 */
export function dueReports(store: Store, now: Date, periods = REPORT_PERIODS): ReportPeriod[] {
  const due: ReportPeriod[] = [];
  for (const period of periods) {
    const key = metadataKeyFor(period);
    const current = periodLabel(period, now);
    const seen = getMetadata(store, key);
    if (seen === undefined) {
      setMetadata(store, key, current);
      continue;
    }
    if (seen !== current) {
      setMetadata(store, key, current);
      due.push(period);
    }
  }
  return due;
}

/** One provider's ranking row, with the duration already formatted. */
export type RenderedProviderRow = {
  providerKey: string;
  displayName: string;
  incidentCount: number;
  openCount: number;
  /** Human duration, e.g. "3h 20min"; "-" when nothing could be measured. */
  downtimeLabel: string;
  /** Ready-to-print right-hand side, e.g. "4 Ausfälle · 3h 20min". */
  line: string;
};

/** A report reduced to display-ready strings, shared by all notifiers. */
export type RenderedReport = {
  title: string;
  summary: string;
  /** Heading above the ranking, or null when there is nothing to rank. */
  rankingHeading: string | null;
  /** Note about incidents that have not been resolved yet, or null. */
  stillOpenNote: string | null;
  rows: RenderedProviderRow[];
  /** Heading above the silent-source list, or null when there is none. */
  silentHeading: string | null;
  /** One ready-to-print line per silent source. */
  silentRows: Array<{ displayName: string; line: string }>;
};

/**
 * Formats a report for display.
 *
 * Wording lives here rather than in the downstream renderer because it
 * depends on the numbers — singular/plural, and the "nothing happened"
 * case reads as a sentence, not an empty list.
 */
export function renderReport(report: StatusReport, messages: Messages): RenderedReport {
  const hasIncidents = report.totalIncidents > 0;
  const stillOpen = report.byProvider.reduce((sum, p) => sum + p.openCount, 0);

  return {
    title: messages.reportTitle(report.period, report.label),
    summary: hasIncidents
      ? messages.reportSummary(
          report.totalIncidents,
          report.providersAffected,
          report.providersTotal,
        )
      : messages.reportNoIncidents,
    rankingHeading: hasIncidents ? messages.reportRankingHeading : null,
    stillOpenNote: stillOpen > 0 ? messages.reportStillOpen(stillOpen) : null,
    silentHeading: report.silent.length > 0 ? messages.reportSilentHeading : null,
    silentRows: report.silent.map((p) => ({
      displayName: p.displayName,
      line: messages.reportSilentLine(p.observedDays, p.upstreamCount),
    })),
    rows: report.byProvider.map((p) => {
      const downtimeLabel = p.downtimeMs && p.downtimeMs > 0 ? formatDuration(p.downtimeMs) : "-";
      return {
        providerKey: p.providerKey,
        displayName: p.displayName,
        incidentCount: p.incidentCount,
        openCount: p.openCount,
        downtimeLabel,
        line: messages.reportProviderLine(p.incidentCount, downtimeLabel),
      };
    }),
  };
}
