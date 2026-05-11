import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { httpGet, httpPost } from "../../src/lib/httpClient.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// `undici.fetch` is what httpClient imports. We mock the module so we can
// inject behaviour without doing real network calls.
vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

import { fetch as undiciFetch } from "undici";

const mockedFetch = vi.mocked(undiciFetch);

function jsonResponse(body: string, status = 200, contentType = "application/json"): unknown {
  return {
    status,
    headers: new Map([["content-type", contentType]]),
    text: () => Promise.resolve(body),
  };
}

describe("httpClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a User-Agent header on GET", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValueOnce(jsonResponse("{}") as any);
    await httpGet("https://example.com", { userAgent: "test-ua/1.0" });

    const [, init] = mockedFetch.mock.calls[0];
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["User-Agent"]).toBe("test-ua/1.0");
  });

  it("propagates Content-Type from the response", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValueOnce(jsonResponse("hi", 200, "text/plain") as any);
    const r = await httpGet("https://example.com");
    expect(r.contentType).toBe("text/plain");
    expect(r.body).toBe("hi");
  });

  it("attaches an AbortSignal to outgoing requests (so the 10s timeout can fire)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValueOnce(jsonResponse("{}") as any);
    await httpGet("https://example.com");
    const [, init] = mockedFetch.mock.calls[0];
    const signal = (init as { signal?: AbortSignal }).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("serialises JSON payloads on POST", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValueOnce(jsonResponse("ok") as any);
    await httpPost("https://example.com", { hello: "world" });

    const [, init] = mockedFetch.mock.calls[0];
    expect((init as { body: string }).body).toBe('{"hello":"world"}');
  });
});
