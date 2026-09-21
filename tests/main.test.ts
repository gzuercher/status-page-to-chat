import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPoll } from "../src/main.js";
import { parseConfigFromString, type AppConfig } from "../src/lib/config.js";
import {
  closeStore,
  createStore,
  getMetadata,
  LAST_DELIVERY_ATTEMPT_METADATA_KEY,
  LAST_DELIVERY_OK_METADATA_KEY,
  LAST_SUCCESSFUL_POLL_METADATA_KEY,
  type Store,
} from "../src/state/store.js";
import { HealthTracker } from "../src/lib/healthTracker.js";
import { evaluateHealth } from "../src/cli/health.js";
import type { AdapterHealthAlert, NormalizedIncident, Notifier } from "../src/lib/types.js";
import type { StatusReport } from "../src/lib/report.js";

// Three independent things are mocked at the boundary, matching what the
// two outages this test simulates actually touch: the adapter's HTTP layer
// (poller), the raw webhook POST the delivery-path reachability probe makes
// (main.ts's maybeProbeWebhookReachability — deliberately NOT routed
// through the Notifier), and the injected Notifier for real business
// traffic (unused here — this fixture never has an incident to report).
vi.mock("../src/lib/httpClient.js", () => ({
  httpGet: vi.fn(),
  httpPost: vi.fn(),
}));

vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock("../src/lib/checkcentralMailer.js", () => ({
  loadCheckCentralConfig: vi.fn(),
  sendCheckin: vi.fn(),
}));

import { httpGet, httpPost } from "../src/lib/httpClient.js";
import { loadCheckCentralConfig, sendCheckin } from "../src/lib/checkcentralMailer.js";

const mockedHttpGet = vi.mocked(httpGet);
const mockedHttpPost = vi.mocked(httpPost);
const mockedLoadCheckCentralConfig = vi.mocked(loadCheckCentralConfig);
const mockedSendCheckin = vi.mocked(sendCheckin);

const FAKE_CHECKCENTRAL_CONFIG = {
  smtpHost: "smtp.azurecomm.net",
  smtpPort: 587,
  smtpUsername: "acs-user",
  smtpPassword: "secret",
  fromEmail: "hostmaster@raptus.com",
  toEmail: "raptus+internal-it@mycheckcentral.cc",
};

function jsonResponse(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

const CONFIG_YAML = `
chatTarget: teamsJson
providers:
  - key: demo
    displayName: Demo
    adapter: atlassian-statuspage
    baseUrl: https://status.example.com
`.trim();

function loadConfig(): AppConfig {
  const result = parseConfigFromString(CONFIG_YAML);
  if (!result.ok) throw result.error;
  return result.config;
}

/** Notifier for real business traffic — never exercised by this fixture (no incidents). */
class RecordingNotifier implements Notifier {
  async notifyOpened(_incident: NormalizedIncident): Promise<void> {}
  async notifyResolved(_incident: NormalizedIncident): Promise<void> {}
  async notifyAdapterHealth(_alert: AdapterHealthAlert): Promise<void> {}
  async notifyReport(_report: StatusReport): Promise<void> {}
}

describe("runPoll → evaluateHealth — the two signals are independent", () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createStore(":memory:");
    process.env.WEBHOOK_URL = "https://logic-app.example/trigger?sig=redacted";
  });

  afterEach(() => {
    closeStore(store);
    delete process.env.WEBHOOK_URL;
  });

  it("simulierter Ausfall des Pollers: kippt den Healthcheck auf 'poll', delivery bleibt gesund", async () => {
    mockedHttpGet.mockRejectedValue(new Error("connect timeout"));
    // The webhook reachability probe is unaffected by the poller outage —
    // any HTTP response (even a 4xx) counts as reachable.
    mockedHttpPost.mockResolvedValue({ status: 400, contentType: "", body: "" });

    await runPoll(loadConfig(), new RecordingNotifier(), store, new HealthTracker());

    expect(getMetadata(store, LAST_SUCCESSFUL_POLL_METADATA_KEY)).toBeUndefined();
    expect(mockedHttpPost).toHaveBeenCalledOnce();
    expect(getMetadata(store, LAST_DELIVERY_OK_METADATA_KEY)).toBeDefined();

    const result = evaluateHealth(store);
    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/poll: no provider has ever been fetched successfully/);
    expect(result.message).not.toMatch(/delivery:/);
  });

  it("simulierter Ausfall des Webhooks: kippt den Healthcheck auf 'delivery', poll bleibt gesund", async () => {
    mockedHttpGet.mockResolvedValue(jsonResponse({ incidents: [] }));
    mockedHttpPost.mockRejectedValue(new Error("connect timeout"));

    await runPoll(loadConfig(), new RecordingNotifier(), store, new HealthTracker());

    expect(getMetadata(store, LAST_SUCCESSFUL_POLL_METADATA_KEY)).toBeDefined();
    expect(getMetadata(store, LAST_DELIVERY_ATTEMPT_METADATA_KEY)).toBeDefined();
    expect(getMetadata(store, LAST_DELIVERY_OK_METADATA_KEY)).toBeUndefined();

    const result = evaluateHealth(store);
    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/delivery: last attempt failed/);
    expect(result.message).not.toMatch(/poll:/);
  });

  it("beide Pfade gesund: der Healthcheck bleibt healthy", async () => {
    mockedHttpGet.mockResolvedValue(jsonResponse({ incidents: [] }));
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "", body: "" });

    await runPoll(loadConfig(), new RecordingNotifier(), store, new HealthTracker());

    const result = evaluateHealth(store);
    expect(result.healthy).toBe(true);
  });
});

describe("CheckCentral check-in — one email, poll/delivery distinguished by body text", () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createStore(":memory:");
    process.env.WEBHOOK_URL = "https://logic-app.example/trigger?sig=redacted";
    mockedLoadCheckCentralConfig.mockReturnValue(FAKE_CHECKCENTRAL_CONFIG);
  });

  afterEach(() => {
    closeStore(store);
    delete process.env.WEBHOOK_URL;
  });

  it("sends nothing when CheckCentral is not configured", async () => {
    mockedLoadCheckCentralConfig.mockReturnValue(undefined);
    mockedHttpGet.mockResolvedValue(jsonResponse({ incidents: [] }));
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "", body: "" });

    await runPoll(loadConfig(), new RecordingNotifier(), store, new HealthTracker());

    expect(mockedSendCheckin).not.toHaveBeenCalled();
  });

  it("sends STATUS: OK on a fully healthy first cycle", async () => {
    mockedHttpGet.mockResolvedValue(jsonResponse({ incidents: [] }));
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "", body: "" });

    await runPoll(loadConfig(), new RecordingNotifier(), store, new HealthTracker());

    expect(mockedSendCheckin).toHaveBeenCalledExactlyOnceWith(
      FAKE_CHECKCENTRAL_CONFIG,
      "Status Page Poller — Health",
      "STATUS: OK",
    );
  });

  it("sends nothing at all when the poller fails, even though delivery is fine", async () => {
    // Silence is deliberate here — CheckCentral's own overdue/Failure state
    // is the signal for a broken poll path, exactly like a plain
    // dead-man's-switch. See main.ts's maybeSendCheckCentralCheckin.
    mockedHttpGet.mockRejectedValue(new Error("connect timeout"));
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "", body: "" });

    await runPoll(loadConfig(), new RecordingNotifier(), store, new HealthTracker());

    expect(mockedSendCheckin).not.toHaveBeenCalled();
  });

  it("sends STATUS: DELIVERY DOWN when the webhook is unreachable, even though polling is fine", async () => {
    mockedHttpGet.mockResolvedValue(jsonResponse({ incidents: [] }));
    mockedHttpPost.mockRejectedValue(new Error("connect timeout"));

    await runPoll(loadConfig(), new RecordingNotifier(), store, new HealthTracker());

    expect(mockedSendCheckin).toHaveBeenCalledExactlyOnceWith(
      FAKE_CHECKCENTRAL_CONFIG,
      "Status Page Poller — Health",
      "STATUS: DELIVERY DOWN",
    );
  });

  it("does not re-send a check-in that was already sent within the interval", async () => {
    mockedHttpGet.mockResolvedValue(jsonResponse({ incidents: [] }));
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "", body: "" });

    await runPoll(loadConfig(), new RecordingNotifier(), store, new HealthTracker());
    expect(mockedSendCheckin).toHaveBeenCalledOnce();

    mockedSendCheckin.mockClear();
    await runPoll(loadConfig(), new RecordingNotifier(), store, new HealthTracker());
    expect(mockedSendCheckin).not.toHaveBeenCalled();
  });
});

describe("evaluateHealth — Grenzfälle", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(":memory:");
  });

  afterEach(() => {
    closeStore(store);
  });

  it("frischer Container ohne jeden Zyklus: healthy (warming up)", () => {
    const result = evaluateHealth(store);
    expect(result.healthy).toBe(true);
    expect(result.message).toMatch(/warming up/);
  });

  it("Poll war zuletzt erfolgreich, aber zu lange her: unhealthy", () => {
    process.env.HEALTH_MAX_AGE_SECONDS = "60";
    try {
      const now = Date.now();
      const old = new Date(now - 120_000).toISOString();
      // A cycle completed (so we're past warm-up), but the last success is stale.
      writeMetadata(store, "last_run_at", old);
      writeMetadata(store, LAST_SUCCESSFUL_POLL_METADATA_KEY, old);
      writeMetadata(store, LAST_DELIVERY_ATTEMPT_METADATA_KEY, old);
      writeMetadata(store, LAST_DELIVERY_OK_METADATA_KEY, old);

      const result = evaluateHealth(store, now);
      expect(result.healthy).toBe(false);
      expect(result.message).toMatch(/poll: last success/);
    } finally {
      delete process.env.HEALTH_MAX_AGE_SECONDS;
    }
  });

  it("Zustellung war zuletzt erfolgreich, aber zu lange her: unhealthy", () => {
    process.env.DELIVERY_MAX_AGE_SECONDS = "60";
    try {
      const now = Date.now();
      const fresh = new Date(now - 10_000).toISOString();
      const old = new Date(now - 120_000).toISOString();
      writeMetadata(store, "last_run_at", fresh);
      writeMetadata(store, LAST_SUCCESSFUL_POLL_METADATA_KEY, fresh);
      writeMetadata(store, LAST_DELIVERY_ATTEMPT_METADATA_KEY, old);
      writeMetadata(store, LAST_DELIVERY_OK_METADATA_KEY, old);

      const result = evaluateHealth(store, now);
      expect(result.healthy).toBe(false);
      expect(result.message).toMatch(/delivery: last success/);
    } finally {
      delete process.env.DELIVERY_MAX_AGE_SECONDS;
    }
  });
});

function writeMetadata(store: Store, key: string, value: string): void {
  store
    .prepare(
      `INSERT INTO metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}
