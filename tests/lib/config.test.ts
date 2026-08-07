import { afterEach, describe, expect, it } from "vitest";
import { parseConfigFromString, withDefaults } from "../../src/lib/config.js";

const SAMPLE = `
chatTarget: teamsJson
providers: []
`.trim();

describe("parseConfigFromString — CHAT_TARGET env override", () => {
  afterEach(() => {
    delete process.env.CHAT_TARGET;
  });

  it("returns YAML chatTarget when override is unset", () => {
    const result = parseConfigFromString(SAMPLE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.chatTarget).toBe("teamsJson");
  });

  it("accepts the one valid value", () => {
    process.env.CHAT_TARGET = "teamsJson";
    const result = parseConfigFromString(SAMPLE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.chatTarget).toBe("teamsJson");
  });

  it("rejects the removed targets instead of silently ignoring them", () => {
    // A deployment still carrying chatTarget: teams must fail loudly rather
    // than quietly posting a format nobody renders any more.
    for (const removed of ["teams", "googleChat"]) {
      process.env.CHAT_TARGET = removed;
      expect(parseConfigFromString(SAMPLE).ok).toBe(false);
    }
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
    if (result.ok) expect(result.config.chatTarget).toBe("teamsJson");
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
      "chatTarget: teamsJson",
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
      "chatTarget: teamsJson",
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
        ["chatTarget: teamsJson", `minImpact: ${level}`, "providers:", ...provider].join("\n"),
      );
      expect(config.minImpact).toBe(level);
    }
  });

  it("rejects an unknown severity level", () => {
    const result = parseConfigFromString(
      ["chatTarget: teamsJson", "minImpact: catastrophic", "providers: []"].join("\n"),
    );
    expect(result.ok).toBe(false);
  });

  it("stays undefined when unset, so nothing is suppressed", () => {
    const config = parse(["chatTarget: teamsJson", "providers:", ...provider].join("\n"));
    expect(config.minImpact).toBeUndefined();
    expect(config.providers[0].minImpact).toBeUndefined();
  });

  it("applies the global floor to a provider that has none", () => {
    const config = parse(
      ["chatTarget: teamsJson", "minImpact: major", "providers:", ...provider].join("\n"),
    );
    expect(withDefaults(config.providers[0], config).minImpact).toBe("major");
  });

  it("lets a provider override the global floor in both directions", () => {
    const config = parse(
      [
        "chatTarget: teamsJson",
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
    const config = parse(["chatTarget: teamsJson", "providers:", ...provider].join("\n"));
    expect(withDefaults(config.providers[0], config)).toBe(config.providers[0]);
  });
});

describe("baseUrl must not point inward", () => {
  function parse(baseUrl: string) {
    return parseConfigFromString(
      [
        "chatTarget: teamsJson",
        "providers:",
        "  - key: probe",
        "    displayName: Probe",
        "    adapter: atlassian-statuspage",
        `    baseUrl: ${baseUrl}`,
      ].join("\n"),
    );
  }

  // The management API is meant to be driven by a chat assistant: someone
  // types a URL, the model writes it. Without this the poller could be
  // aimed at cloud metadata or host-network services every five minutes.
  it.each([
    "http://169.254.169.254/",
    "http://localhost:8080",
    "http://127.0.0.1/status",
    "http://10.1.2.3/",
    "http://192.168.1.10/",
    "http://172.16.0.5/",
    "http://[::1]/",
  ])("rejects %s", (url) => {
    expect(parse(url).ok).toBe(false);
  });

  it.each(["https://status.example.com", "https://www.githubstatus.com", "http://172.32.0.1/"])(
    "accepts %s",
    (url) => {
      expect(parse(url).ok).toBe(true);
    },
  );
});
