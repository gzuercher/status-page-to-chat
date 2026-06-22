import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeTranslator, NoopTranslator, createTranslator } from "../../src/lib/translator.js";
import { createStore, type Store } from "../../src/state/store.js";

vi.mock("../../src/lib/httpClient.js", () => ({
  httpPost: vi.fn(),
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpPost } from "../../src/lib/httpClient.js";

const mockedHttpPost = vi.mocked(httpPost);

/** Builds an Anthropic-shaped success response body. */
function anthropicBody(text: string): { status: number; contentType: string; body: string } {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ content: [{ type: "text", text }] }),
  };
}

describe("ClaudeTranslator", () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("translates via the API and caches the result (second call hits the cache)", async () => {
    mockedHttpPost.mockResolvedValueOnce(anthropicBody("CDN-Verschlechterung"));
    const translator = new ClaudeTranslator("sk-test", "de", store);

    const first = await translator.translate("CDN Degradation");
    const second = await translator.translate("CDN Degradation");

    expect(first).toBe("CDN-Verschlechterung");
    expect(second).toBe("CDN-Verschlechterung");
    expect(mockedHttpPost).toHaveBeenCalledOnce();
  });

  it("sends the API key and anthropic-version headers", async () => {
    mockedHttpPost.mockResolvedValueOnce(anthropicBody("Hallo"));
    const translator = new ClaudeTranslator("sk-secret", "de", store);

    await translator.translate("Hello");

    const [, , options] = mockedHttpPost.mock.calls[0];
    expect(options?.headers?.["x-api-key"]).toBe("sk-secret");
    expect(options?.headers?.["anthropic-version"]).toBeDefined();
  });

  it("falls back to the original text when the API call fails", async () => {
    mockedHttpPost.mockRejectedValueOnce(new Error("boom"));
    const translator = new ClaudeTranslator("sk-test", "de", store);

    expect(await translator.translate("CDN Degradation")).toBe("CDN Degradation");
  });

  it("falls back to the original text on a non-2xx response", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 401, contentType: "", body: "unauthorized" });
    const translator = new ClaudeTranslator("sk-test", "de", store);

    expect(await translator.translate("CDN Degradation")).toBe("CDN Degradation");
  });

  it("does not call the API for blank input", async () => {
    const translator = new ClaudeTranslator("sk-test", "de", store);

    expect(await translator.translate("   ")).toBe("   ");
    expect(mockedHttpPost).not.toHaveBeenCalled();
  });
});

describe("createTranslator", () => {
  let store: Store;
  const original = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    store = createStore(":memory:");
  });

  afterEach(() => {
    store.close();
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  });

  it("returns a NoopTranslator when no API key is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(createTranslator("de", store)).toBeInstanceOf(NoopTranslator);
  });

  it("returns a ClaudeTranslator when an API key is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(createTranslator("de", store)).toBeInstanceOf(ClaudeTranslator);
  });
});
