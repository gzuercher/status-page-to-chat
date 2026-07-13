import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamsNotifier } from "../../src/notifiers/teams.js";
import { NoopTranslator, type Translator } from "../../src/lib/translator.js";
import type { NormalizedIncident } from "../../src/lib/types.js";

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

/** Translator that records its input and returns a recognisable marker. */
class FakeTranslator implements Translator {
  public calls: string[] = [];
  async translate(text: string): Promise<string> {
    this.calls.push(text);
    return `[de]${text}`;
  }
}

/** The Adaptive Card sent in the first httpPost call as JSON text. */
function lastCardJson(): string {
  const [, payload] = mockedHttpPost.mock.calls[0];
  return JSON.stringify(payload);
}

function newNotifier(translator: Translator = new NoopTranslator()): TeamsNotifier {
  return new TeamsNotifier("https://teams.webhook.office.com/test", translator, "de");
}

describe("TeamsNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the bare Adaptive Card (no message/attachments wrapper) for an opened incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyOpened(testIncident);

    expect(mockedHttpPost).toHaveBeenCalledOnce();
    const [url, payload] = mockedHttpPost.mock.calls[0];
    expect(url).toBe("https://teams.webhook.office.com/test");

    // The Workflows webhook expects the bare card — the legacy
    // `{ type: "message", attachments: [...] }` wrapper renders blank.
    const card = payload as { type: string; attachments?: unknown; body?: unknown[] };
    expect(card.type).toBe("AdaptiveCard");
    expect(card.attachments).toBeUndefined();
    expect(Array.isArray(card.body)).toBe(true);
  });

  it("renders full width, a red attention container and the German opened badge", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyOpened(testIncident);

    const json = lastCardJson();
    expect(json).toContain('"width":"Full"');
    expect(json).toContain('"style":"attention"');
    expect(json).toContain("Störung gemeldet");
    expect(json).toContain("Details ansehen");
  });

  it("renders a green good container and the German resolved badge", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const resolved = { ...testIncident, status: "resolved" as const };
    await newNotifier().notifyResolved(resolved);

    const json = lastCardJson();
    expect(json).toContain('"style":"good"');
    expect(json).toContain("Behoben");
  });

  it("machine-translates the incident title and renders the translation", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });
    const translator = new FakeTranslator();

    await newNotifier(translator).notifyOpened(testIncident);

    expect(translator.calls).toEqual(["CDN Degradation"]);
    expect(lastCardJson()).toContain("[de]CDN Degradation");
  });

  it("renders the per-provider description when present", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyOpened({
      ...testIncident,
      description: "Visueller Website-Baukasten.",
    });

    expect(lastCardJson()).toContain("Visueller Website-Baukasten.");
  });

  it("throws on a non-2xx response and calls httpPost once (retry lives in the client)", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 500, contentType: "", body: "Internal Error" });

    await expect(newNotifier().notifyOpened(testIncident)).rejects.toThrow("HTTP 500");
    expect(mockedHttpPost).toHaveBeenCalledOnce();
  });

  it("renders an adapter-health card with the system header, wrench emoji and German body", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyAdapterHealth({
      kind: "down",
      providerKey: "bitwarden",
      providerName: "Bitwarden",
      logoUrl: "https://logo.example/bitwarden.png",
      errorCategory: "HTTP 404",
      durationLabel: "2h",
    });

    const json = lastCardJson();
    expect(json).toContain("status-page-to-chat");
    expect(json).toContain("🛠️");
    expect(json).toContain('"style":"attention"');
    expect(json).toContain("Bitwarden");
    expect(json).toContain("HTTP 404");
    expect(json).toContain("2h");
    expect(json).toContain("fehlgeschlagen");
  });

  it("localises a known error category into German", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyAdapterHealth({
      kind: "down",
      providerKey: "bitwarden",
      providerName: "Bitwarden",
      errorCategory: "Timeout",
      durationLabel: "2h",
    });

    expect(lastCardJson()).toContain("Zeitüberschreitung");
  });

  it("uses a distinct recovered-emoji combination and green container", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyAdapterHealth({
      kind: "recovered",
      providerKey: "bitwarden",
      providerName: "Bitwarden",
      durationLabel: "3h 10min",
    });

    const json = lastCardJson();
    expect(json).toContain("🛠️✅");
    expect(json).toContain('"style":"good"');
    expect(json).toContain("3h 10min");
    expect(json).toContain("wieder aktiv");
  });
});
