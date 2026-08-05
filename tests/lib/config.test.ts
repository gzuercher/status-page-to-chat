import { afterEach, describe, expect, it } from "vitest";
import { parseConfigFromString, withDefaults } from "../../src/lib/config.js";

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

describe("parseConfigFromString — componentFilter normalisation", () => {
  function filterOf(yaml: string): string[] | undefined {
    const result = parseConfigFromString(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    return result.config.providers[0].componentFilter;
  }

  function providerYaml(filterLine: string): string {
    return [
      "chatTarget: googleChat",
      "providers:",
      "  - key: claude",
      "    displayName: Claude",
      "    adapter: atlassian-statuspage",
      "    baseUrl: https://status.claude.com",
      filterLine,
    ].join("\n");
  }

  it("splits a comma-separated string into individual filters", () => {
    // Regression: YAML parses `a, b, c` as ONE string. Matching that
    // verbatim as a substring never hits a real component name, so the
    // provider silently reported zero incidents.
    expect(
      filterOf(providerYaml("    componentFilter: claude.ai, Claude Code, api.anthropic.com")),
    ).toEqual(["claude.ai", "Claude Code", "api.anthropic.com"]);
  });

  it("keeps a single value as a one-element list", () => {
    expect(filterOf(providerYaml("    componentFilter: Recursive DNS"))).toEqual(["Recursive DNS"]);
  });

  it("passes a YAML list through, trimming entries", () => {
    const yaml = [
      "chatTarget: googleChat",
      "providers:",
      "  - key: claude",
      "    displayName: Claude",
      "    adapter: atlassian-statuspage",
      "    baseUrl: https://status.claude.com",
      "    componentFilter:",
      "      - claude.ai",
      "      - Claude Code",
    ].join("\n");
    expect(filterOf(yaml)).toEqual(["claude.ai", "Claude Code"]);
  });

  it("treats an empty or comma-only filter as no filter at all", () => {
    expect(filterOf(providerYaml('    componentFilter: ""'))).toBeUndefined();
    expect(filterOf(providerYaml('    componentFilter: " , , "'))).toBeUndefined();
  });

  it("leaves componentFilter undefined when absent", () => {
    expect(filterOf(providerYaml("    userAgent: test-agent"))).toBeUndefined();
  });
});

describe("minImpact", () => {
  function parse(yaml: string) {
    const result = parseConfigFromString(yaml);
    if (!result.ok) throw new Error(result.error.message);
    return result.config;
  }

  const provider = [
    "  - key: claude",
    "    displayName: Claude",
    "    adapter: atlassian-statuspage",
    "    baseUrl: https://status.claude.com",
  ];

  it("accepts the four Statuspage severity levels", () => {
    for (const level of ["none", "minor", "major", "critical"]) {
      const config = parse(
        ["chatTarget: googleChat", `minImpact: ${level}`, "providers:", ...provider].join("\n"),
      );
      expect(config.minImpact).toBe(level);
    }
  });

  it("rejects an unknown severity level", () => {
    const result = parseConfigFromString(
      ["chatTarget: googleChat", "minImpact: catastrophic", "providers: []"].join("\n"),
    );
    expect(result.ok).toBe(false);
  });

  it("stays undefined when unset, so nothing is suppressed", () => {
    const config = parse(["chatTarget: googleChat", "providers:", ...provider].join("\n"));
    expect(config.minImpact).toBeUndefined();
    expect(config.providers[0].minImpact).toBeUndefined();
  });

  it("applies the global floor to a provider that has none", () => {
    const config = parse(
      ["chatTarget: googleChat", "minImpact: major", "providers:", ...provider].join("\n"),
    );
    expect(withDefaults(config.providers[0], config).minImpact).toBe("major");
  });

  it("lets a provider override the global floor in both directions", () => {
    const config = parse(
      [
        "chatTarget: googleChat",
        "minImpact: major",
        "providers:",
        ...provider,
        "    minImpact: none",
        "  - key: bexio",
        "    displayName: Bexio",
        "    adapter: atlassian-statuspage",
        "    baseUrl: https://www.bexio-status.com",
        "    minImpact: critical",
      ].join("\n"),
    );
    expect(withDefaults(config.providers[0], config).minImpact).toBe("none");
    expect(withDefaults(config.providers[1], config).minImpact).toBe("critical");
  });

  it("leaves the provider untouched when no global floor is set", () => {
    const config = parse(["chatTarget: googleChat", "providers:", ...provider].join("\n"));
    expect(withDefaults(config.providers[0], config)).toBe(config.providers[0]);
  });
});
