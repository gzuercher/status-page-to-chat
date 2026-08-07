import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamsJsonNotifier } from "../../src/notifiers/teamsJson.js";
import type { NormalizedIncident } from "../../src/lib/types.js";
import type { StatusReport } from "../../src/lib/report.js";
import type { Translator } from "../../src/lib/translator.js";

vi.mock("../../src/lib/httpClient.js", () => ({
  httpPost: vi.fn(),
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpPost } from "../../src/lib/httpClient.js";

const mockedHttpPost = vi.mocked(httpPost);

const testIncident: NormalizedIncident = {
  externalId: "inc-001",
  providerKey: "webflow",
  displayName: "Webflow",
  title: "CDN Degradation",
  status: "open",
  url: "https://stspg.io/test001",
  startedAt: "2026-04-15T10:00:00Z",
  updatedAt: "2026-04-15T10:30:00Z",
};

/** The payload sent in the most recent httpPost call. */
function lastPayload(): Record<string, unknown> {
  const calls = mockedHttpPost.mock.calls;
  const [, payload] = calls[calls.length - 1];
  return payload as Record<string, unknown>;
}

/** Translator stub: marks its input so translation is visible in assertions. */
const fakeTranslator: Translator = {
  translate: async (text: string) => `[de] ${text}`,
};

function newNotifier(translator: Translator = fakeTranslator): TeamsJsonNotifier {
  return new TeamsJsonNotifier("https://logic-app.example/trigger", "de", translator);
}

describe("TeamsJsonNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the raw incident envelope (not an Adaptive Card) for an opened incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyOpened(testIncident);

    expect(mockedHttpPost).toHaveBeenCalledOnce();
    const [url, payload] = mockedHttpPost.mock.calls[0];
    expect(url).toBe("https://logic-app.example/trigger");

    const p = payload as Record<string, unknown>;
    // It is data, not presentation: no card markers.
    expect(p.type).toBeUndefined();
    expect(p.body).toBeUndefined();
    expect(p).toMatchObject({
      schemaVersion: 3,
      source: "status-page-to-chat",
      event: "incident.opened",
      severity: "problem",
      language: "de",
    });
    // Every incident field survives; the title arrives translated, with
    // the provider's own wording alongside it.
    expect(p.incident).toMatchObject({
      ...testIncident,
      title: "[de] CDN Degradation",
      titleOriginal: "CDN Degradation",
    });
  });

  it("always includes optional fields as null so the key set is stable across variants", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    // testIncident has neither description nor logoUrl.
    await newNotifier().notifyOpened(testIncident);

    const incident = lastPayload().incident as Record<string, unknown>;
    expect(incident).toHaveProperty("description", null);
    expect(incident).toHaveProperty("logoUrl", null);
  });

  it("emits null errorCategory for non-down adapter alerts, string for down", async () => {
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyAdapterHealth({
      kind: "recovered",
      providerKey: "wedos",
      providerName: "WEDOS",
      durationLabel: "2h",
    });
    const recovered = lastPayload();
    expect(recovered).toMatchObject({ event: "adapter.recovered", severity: "ok" });
    expect(recovered.alert as Record<string, unknown>).toMatchObject({
      logoUrl: null,
      errorCategory: null,
    });

    await newNotifier().notifyAdapterHealth({
      kind: "down",
      providerKey: "wedos",
      providerName: "WEDOS",
      errorCategory: "HTTP 503",
      durationLabel: "2h",
    });
    expect((lastPayload().alert as Record<string, unknown>).errorCategory).toBe("HTTP 503");
  });

  it("translates the incident title and keeps the original alongside", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyOpened(testIncident);

    const incident = lastPayload().incident as Record<string, unknown>;
    expect(incident.title).toBe("[de] CDN Degradation");
    expect(incident.titleOriginal).toBe("CDN Degradation");
  });

  it("falls back to the provider's wording when translation fails", async () => {
    // translator.ts swallows its own errors, but a notifier must not depend
    // on that: a card is never worth losing over a translation problem.
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });
    const passthrough: Translator = { translate: async (text: string) => text };

    await newNotifier(passthrough).notifyOpened(testIncident);

    const incident = lastPayload().incident as Record<string, unknown>;
    expect(incident.title).toBe("CDN Degradation");
    expect(incident.titleOriginal).toBe("CDN Degradation");
  });

  it("uses the incident.resolved event for a resolved incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const resolved = { ...testIncident, status: "resolved" as const };
    await newNotifier().notifyResolved(resolved);

    expect(lastPayload()).toMatchObject({ event: "incident.resolved" });
  });

  it("maps an adapter-health alert kind onto the adapter.* event and nests the alert", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyAdapterHealth({
      kind: "down",
      providerKey: "bitwarden",
      providerName: "Bitwarden",
      errorCategory: "timeout",
      durationLabel: "15 minutes",
    });

    const p = lastPayload();
    expect(p).toMatchObject({
      schemaVersion: 3,
      source: "status-page-to-chat",
      event: "adapter.down",
      severity: "problem",
    });
    expect(p.alert).toMatchObject({ kind: "down", providerKey: "bitwarden" });
  });

  it("throws on a non-2xx response and calls httpPost once (retry lives in the client)", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 500, contentType: "", body: "Internal Error" });

    await expect(newNotifier().notifyOpened(testIncident)).rejects.toThrow("HTTP 500");
    expect(mockedHttpPost).toHaveBeenCalledOnce();
  });
});

describe("TeamsJsonNotifier — report envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "application/json", body: "" });
  });

  const report: StatusReport = {
    period: "weekly",
    label: "2026-W31",
    from: "2026-07-27T00:00:00.000Z",
    to: "2026-08-03T00:00:00.000Z",
    totalIncidents: 3,
    providersTotal: 24,
    providersAffected: 2,
    byProvider: [
      {
        providerKey: "retool",
        displayName: "Retool",
        incidentCount: 2,
        openCount: 0,
        downtimeMs: 90 * 60_000,
      },
      {
        providerKey: "figma",
        displayName: 'Figma "EU"',
        incidentCount: 1,
        openCount: 1,
        downtimeMs: null,
      },
    ],
    silent: [{ providerKey: "wedos", displayName: "WEDOS", observedDays: 40, upstreamCount: 0 }],
  };

  it("labels the event by period and marks it as a summary, not a problem", async () => {
    await newNotifier().notifyReport(report);
    const payload = lastPayload();
    expect(payload.event).toBe("report.weekly");
    expect(payload.severity).toBe("ok");
    expect(payload.schemaVersion).toBe(3);
  });

  it("carries data only — no pre-rendered wording", async () => {
    // v3: the renderer builds its own sentences from the numbers.
    await newNotifier().notifyReport(report);
    const r = lastPayload().report as Record<string, unknown>;
    for (const gone of [
      "title",
      "summary",
      "rankingHeading",
      "silentHeading",
      "stillOpenNote",
      "facts",
      "silentFacts",
    ]) {
      expect(r).not.toHaveProperty(gone);
    }
    expect(r).not.toHaveProperty("providers.0.line");
    expect((r.providers as Array<Record<string, unknown>>)[0]).not.toHaveProperty("line");
  });

  it("keeps the formatted duration, the one thing WDL cannot derive", async () => {
    await newNotifier().notifyReport(report);
    const providers = (lastPayload().report as Record<string, unknown>).providers as Array<
      Record<string, unknown>
    >;
    expect(providers[0].downtimeLabel).toBe("1h 30min");
    // Nothing measurable closed — label degrades, raw value stays null.
    expect(providers[1]).toMatchObject({ downtimeMs: null, downtimeLabel: "-" });
  });

  it("carries the raw values a renderer needs to format things itself", async () => {
    await newNotifier().notifyReport(report);
    const r = lastPayload().report as Record<string, unknown>;
    const providers = r.providers as Array<Record<string, unknown>>;
    expect(providers[0]).toMatchObject({
      providerKey: "retool",
      incidentCount: 2,
      openCount: 0,
      downtimeMs: 90 * 60_000,
    });
    // Nothing measurable closed — the raw value stays null, not 0.
    expect(providers[1].downtimeMs).toBeNull();
    expect((r.silentProviders as Array<Record<string, unknown>>)[0]).toMatchObject({
      providerKey: "wedos",
      observedDays: 40,
      upstreamCount: 0,
    });
  });

  it("sends empty arrays rather than omitting them when nothing happened", async () => {
    // A stable key set is what lets the renderer reference fields unconditionally.
    await newNotifier().notifyReport({
      ...report,
      totalIncidents: 0,
      providersAffected: 0,
      byProvider: [],
      silent: [],
    });
    const r = lastPayload().report as Record<string, unknown>;
    expect(r.providers).toEqual([]);
    expect(r.silentProviders).toEqual([]);
    expect(r.totalIncidents).toBe(0);
  });
});
