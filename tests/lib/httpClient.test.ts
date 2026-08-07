import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { httpGet, httpPost } from "../../src/lib/httpClient.js";

// Mirrored test (Familienstandard mit social-to-chat). `retry-after: "0"`
// keeps the backoff instantaneous so the retry paths stay fast.
describe("httpClient", () => {
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  it("returns status, content-type and body", async () => {
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/ok", method: "GET" })
      .reply(200, '{"a":1}', { headers: { "content-type": "application/json" } });

    const res = await httpGet("https://api.example.com/ok");
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/json");
    expect(res.body).toBe('{"a":1}');
  });

  it("retries on 429 and honours Retry-After", async () => {
    const pool = mockAgent.get("https://api.example.com");
    pool
      .intercept({ path: "/flaky", method: "GET" })
      .reply(429, "slow down", { headers: { "retry-after": "0" } })
      .times(1);
    pool.intercept({ path: "/flaky", method: "GET" }).reply(200, "ok").times(1);

    const res = await httpGet("https://api.example.com/flaky");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("returns the last response after retries are exhausted", async () => {
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/broken", method: "GET" })
      .reply(429, "nope", { headers: { "retry-after": "0" } })
      .times(3); // first attempt + 2 retries

    const res = await httpGet("https://api.example.com/broken");
    expect(res.status).toBe(429);
  });

  it("does not retry when retries: 0", async () => {
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/once", method: "GET" })
      .reply(500, "boom")
      .times(1);

    const res = await httpGet("https://api.example.com/once", { retries: 0 });
    expect(res.status).toBe(500);
  });

  it("does not retry 4xx other than 429", async () => {
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/notfound", method: "GET" })
      .reply(404, "missing")
      .times(1);

    const res = await httpGet("https://api.example.com/notfound");
    expect(res.status).toBe(404);
  });

  it("serialises the payload as JSON on POST", async () => {
    let receivedBody = "";
    mockAgent
      .get("https://hook.example.com")
      .intercept({
        path: "/webhook",
        method: "POST",
        body: (body) => {
          receivedBody = body;
          return true;
        },
      })
      .reply(202, "accepted");

    const res = await httpPost("https://hook.example.com/webhook", { hello: "world" });
    expect(res.status).toBe(202);
    expect(JSON.parse(receivedBody)).toEqual({ hello: "world" });
  });

  it("refuses a response larger than the cap instead of buffering it", () => {
    // Without a cap the far end decides how much memory we spend.
    const huge = "x".repeat(6 * 1024 * 1024);
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/huge", method: "GET" })
      .reply(200, huge, { headers: { "content-type": "text/plain" } });

    return expect(httpGet("https://api.example.com/huge", { retries: 0 })).rejects.toThrow(
      /exceeds/,
    );
  });

  it("accepts a response comfortably below the cap", async () => {
    const big = "y".repeat(1024 * 1024);
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/big", method: "GET" })
      .reply(200, big, { headers: { "content-type": "text/plain" } });

    const res = await httpGet("https://api.example.com/big", { retries: 0 });
    expect(res.body.length).toBe(big.length);
  });
});
