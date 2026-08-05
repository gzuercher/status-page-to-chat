import { beforeEach, describe, expect, it } from "vitest";
import {
  buildReport,
  dueReports,
  isoWeek,
  metadataKeyFor,
  periodBounds,
  periodLabel,
  renderReport,
} from "../../src/lib/report.js";
import { createStore, upsertIncident, setMetadata, type Store } from "../../src/state/store.js";
import { getMessages } from "../../src/lib/i18n.js";
import type { ProviderConfig } from "../../src/lib/config.js";
import type { NormalizedIncident } from "../../src/lib/types.js";

const PROVIDERS: ProviderConfig[] = [
  {
    key: "vercel",
    displayName: "Vercel",
    adapter: "atlassian-statuspage",
    baseUrl: "https://v.example.com",
  },
  {
    key: "figma",
    displayName: "Figma",
    adapter: "atlassian-statuspage",
    baseUrl: "https://f.example.com",
  },
  {
    key: "bexio",
    displayName: "Bexio",
    adapter: "atlassian-statuspage",
    baseUrl: "https://b.example.com",
  },
];

function incident(
  providerKey: string,
  externalId: string,
  startedAt: string,
  updatedAt: string,
  status: "open" | "resolved",
): NormalizedIncident {
  return {
    externalId,
    providerKey,
    displayName: providerKey,
    title: `${providerKey} ${externalId}`,
    status,
    url: "https://example.com",
    startedAt,
    updatedAt,
  };
}

describe("isoWeek", () => {
  it("numbers weeks the way a European calendar does", () => {
    // 2026-01-01 is a Thursday, so it belongs to week 1 of 2026.
    expect(isoWeek(new Date("2026-01-01T12:00:00Z"))).toEqual({ year: 2026, week: 1 });
    expect(isoWeek(new Date("2026-08-05T12:00:00Z"))).toEqual({ year: 2026, week: 32 });
  });

  it("assigns a late-December date to week 1 of the following ISO year", () => {
    // 2025-12-29 is the Monday of the week containing 2026-01-01 (Thursday).
    expect(isoWeek(new Date("2025-12-29T12:00:00Z"))).toEqual({ year: 2026, week: 1 });
  });
});

describe("periodLabel", () => {
  const date = new Date("2026-08-05T12:00:00Z");

  it("labels each cadence distinctly", () => {
    expect(periodLabel("weekly", date)).toBe("2026-W32");
    expect(periodLabel("monthly", date)).toBe("2026-08");
    expect(periodLabel("quarterly", date)).toBe("2026-Q3");
  });

  it("keeps the label stable across a whole period", () => {
    const mondayOfSameWeek = new Date("2026-08-03T00:00:00Z");
    const sundayOfSameWeek = new Date("2026-08-09T23:59:59Z");
    expect(periodLabel("weekly", mondayOfSameWeek)).toBe(periodLabel("weekly", sundayOfSameWeek));
  });
});

describe("periodBounds", () => {
  it("starts the week on Monday", () => {
    const { from, to } = periodBounds("weekly", new Date("2026-08-05T12:00:00Z"));
    expect(from).toBe("2026-08-03T00:00:00.000Z");
    expect(to).toBe("2026-08-10T00:00:00.000Z");
  });

  it("covers the calendar month", () => {
    const { from, to } = periodBounds("monthly", new Date("2026-08-05T12:00:00Z"));
    expect(from).toBe("2026-08-01T00:00:00.000Z");
    expect(to).toBe("2026-09-01T00:00:00.000Z");
  });

  it("covers three months for a quarter, including the year rollover", () => {
    expect(periodBounds("quarterly", new Date("2026-11-15T00:00:00Z"))).toEqual({
      from: "2026-10-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    });
  });
});

describe("buildReport", () => {
  let store: Store;
  // A Wednesday; the previous week is 2026-07-27 .. 2026-08-03.
  const now = new Date("2026-08-05T09:00:00Z");

  beforeEach(async () => {
    store = createStore(":memory:");
    // Two Vercel outages inside the window, 1h and 30min.
    await upsertIncident(
      store,
      incident("vercel", "v1", "2026-07-28T10:00:00Z", "2026-07-28T11:00:00Z", "resolved"),
      true,
      true,
    );
    await upsertIncident(
      store,
      incident("vercel", "v2", "2026-07-30T10:00:00Z", "2026-07-30T10:30:00Z", "resolved"),
      true,
      true,
    );
    // One Figma outage inside the window, 2h.
    await upsertIncident(
      store,
      incident("figma", "f1", "2026-07-29T10:00:00Z", "2026-07-29T12:00:00Z", "resolved"),
      true,
      true,
    );
    // Outside the window — must not be counted.
    await upsertIncident(
      store,
      incident("bexio", "b1", "2026-08-04T10:00:00Z", "2026-08-04T11:00:00Z", "resolved"),
      true,
      true,
    );
  });

  it("counts only incidents that started inside the window", () => {
    const report = buildReport(store, PROVIDERS, "weekly", now);
    expect(report.label).toBe("2026-W31");
    expect(report.totalIncidents).toBe(3);
    expect(report.byProvider.map((p) => p.providerKey)).toEqual(["vercel", "figma"]);
  });

  it("ranks by incident count, then by downtime", () => {
    const report = buildReport(store, PROVIDERS, "weekly", now);
    expect(report.byProvider[0]).toMatchObject({ providerKey: "vercel", incidentCount: 2 });
    expect(report.byProvider[0].downtimeMs).toBe(90 * 60_000);
    expect(report.byProvider[1].downtimeMs).toBe(120 * 60_000);
  });

  it("resolves display names from the config", () => {
    const report = buildReport(store, PROVIDERS, "weekly", now);
    expect(report.byProvider[0].displayName).toBe("Vercel");
  });

  it("falls back to the key for a provider no longer configured", () => {
    const report = buildReport(store, [], "weekly", now);
    expect(report.byProvider[0].displayName).toBe("vercel");
    expect(report.providersTotal).toBe(0);
  });

  it("counts an open incident but excludes it from the downtime sum", async () => {
    await upsertIncident(
      store,
      incident("figma", "f2", "2026-07-31T10:00:00Z", "2026-07-31T10:00:00Z", "open"),
      true,
      false,
    );
    const report = buildReport(store, PROVIDERS, "weekly", now);
    const figma = report.byProvider.find((p) => p.providerKey === "figma");
    expect(figma).toMatchObject({ incidentCount: 2, openCount: 1 });
    // Unchanged: only the resolved 2h incident contributes.
    expect(figma?.downtimeMs).toBe(120 * 60_000);
  });

  it("reports zeroes for a period with no incidents at all", () => {
    const report = buildReport(store, PROVIDERS, "weekly", new Date("2026-09-16T09:00:00Z"));
    expect(report.totalIncidents).toBe(0);
    expect(report.byProvider).toEqual([]);
    expect(report.providersAffected).toBe(0);
  });

  it("ignores inverted timestamps instead of producing NaN", async () => {
    await upsertIncident(
      store,
      incident("bexio", "b2", "2026-07-30T12:00:00Z", "2026-07-30T09:00:00Z", "resolved"),
      true,
      true,
    );
    const report = buildReport(store, PROVIDERS, "weekly", now);
    const bexio = report.byProvider.find((p) => p.providerKey === "bexio");
    expect(bexio?.incidentCount).toBe(1);
    expect(bexio?.downtimeMs).toBeNull();
  });
});

describe("dueReports", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(":memory:");
  });

  it("seeds silently on first run so a fresh container reports nothing", () => {
    expect(dueReports(store, new Date("2026-08-05T09:00:00Z"))).toEqual([]);
  });

  it("fires once when the period rolls over, and not again", () => {
    dueReports(store, new Date("2026-08-05T09:00:00Z")); // seed, week 32
    const nextWeek = new Date("2026-08-11T09:00:00Z"); // week 33
    expect(dueReports(store, nextWeek)).toEqual(["weekly"]);
    expect(dueReports(store, nextWeek)).toEqual([]);
  });

  it("fires all three cadences when a quarter, month and week roll over together", () => {
    // 2026-09-30 is in week 40, month 09, Q3.
    dueReports(store, new Date("2026-09-30T09:00:00Z"));
    // 2026-10-01 is in week 40 as well — only month and quarter changed.
    expect(dueReports(store, new Date("2026-10-01T09:00:00Z"))).toEqual(["monthly", "quarterly"]);
  });

  it("still fires after a missed poll, without repeating older periods", () => {
    setMetadata(store, metadataKeyFor("weekly"), "2026-W30");
    // Container was down for a week; it is now week 32.
    const due = dueReports(store, new Date("2026-08-05T09:00:00Z"), ["weekly"]);
    expect(due).toEqual(["weekly"]);
    expect(dueReports(store, new Date("2026-08-06T09:00:00Z"), ["weekly"])).toEqual([]);
  });
});

describe("renderReport", () => {
  const messages = getMessages("de");

  function reportWith(overrides: Partial<Parameters<typeof renderReport>[0]> = {}) {
    return renderReport(
      {
        period: "weekly",
        label: "2026-W31",
        from: "2026-07-27T00:00:00.000Z",
        to: "2026-08-03T00:00:00.000Z",
        totalIncidents: 3,
        providersTotal: 24,
        providersAffected: 2,
        byProvider: [
          {
            providerKey: "vercel",
            displayName: "Vercel",
            incidentCount: 2,
            openCount: 0,
            downtimeMs: 90 * 60_000,
          },
          {
            providerKey: "figma",
            displayName: "Figma",
            incidentCount: 1,
            openCount: 1,
            downtimeMs: null,
          },
        ],
        ...overrides,
      },
      messages,
    );
  }

  it("renders a German headline naming the calendar week", () => {
    expect(reportWith().title).toBe("Wochenbericht KW 31/2026");
  });

  it("states totals and formats each provider row", () => {
    const rendered = reportWith();
    expect(rendered.summary).toBe("3 Ausfälle bei 2 von 24 Diensten.");
    expect(rendered.rows[0].line).toBe("2 Ausfälle · 1h 30min gesamt");
  });

  it("omits the duration when nothing measurable closed", () => {
    expect(reportWith().rows[1].line).toBe("1 Ausfall");
  });

  it("notes unresolved outages", () => {
    expect(reportWith().stillOpenNote).toBe("1 Ausfall ist noch offen.");
  });

  it("reads as a sentence when nothing happened", () => {
    const rendered = reportWith({ totalIncidents: 0, providersAffected: 0, byProvider: [] });
    expect(rendered.summary).toBe("Keine Ausfälle — alle überwachten Dienste liefen durchgehend.");
    expect(rendered.rankingHeading).toBeNull();
    expect(rendered.stillOpenNote).toBeNull();
  });
});
