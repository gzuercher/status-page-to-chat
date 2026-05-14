import { afterEach, describe, expect, it } from "vitest";
import { parseConfigFromString } from "../../src/lib/config.js";

const SAMPLE = `
chatTarget: googleChat
providers: []
`.trim();

describe("parseConfigFromString — CHAT_TARGET env override", () => {
  afterEach(() => {
    delete process.env.CHAT_TARGET;
  });

  it("returns YAML chatTarget when override is unset", () => {
    const result = parseConfigFromString(SAMPLE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.chatTarget).toBe("googleChat");
  });

  it("overrides chatTarget when env var is set to a valid value", () => {
    process.env.CHAT_TARGET = "teams";
    const result = parseConfigFromString(SAMPLE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.chatTarget).toBe("teams");
  });

  it("rejects an invalid CHAT_TARGET override", () => {
    process.env.CHAT_TARGET = "slack";
    const result = parseConfigFromString(SAMPLE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/CHAT_TARGET/);
  });

  it("ignores empty string override", () => {
    process.env.CHAT_TARGET = "";
    const result = parseConfigFromString(SAMPLE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.chatTarget).toBe("googleChat");
  });
});
