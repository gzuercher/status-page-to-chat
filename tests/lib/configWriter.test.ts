import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upsertProviderInYaml, removeProviderFromYaml } from "../../src/lib/configWriter.js";

const STARTER_YAML = `# Header comment that must survive every edit.
chatTarget: googleChat

providers:
  # Bitbucket: Atlassian Statuspage
  - key: bitbucket
    displayName: Bitbucket
    adapter: atlassian-statuspage
    baseUrl: https://bitbucket.status.atlassian.com

  - key: figma
    displayName: Figma
    adapter: atlassian-statuspage
    baseUrl: https://status.figma.com
`;

describe("configWriter", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfgwriter-"));
    configPath = join(dir, "providers.yaml");
    writeFileSync(configPath, STARTER_YAML, "utf-8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends a new provider and preserves header comment", () => {
    const result = upsertProviderInYaml(
      {
        key: "webflow",
        displayName: "Webflow",
        adapter: "atlassian-statuspage",
        baseUrl: "https://status.webflow.com",
      },
      configPath,
    );
    expect(result.created).toBe(true);

    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("# Header comment that must survive every edit.");
    expect(after).toContain("# Bitbucket: Atlassian Statuspage");
    expect(after).toContain("key: webflow");
    expect(after).toContain("baseUrl: https://status.webflow.com");
  });

  it("updates in place when key already exists", () => {
    const result = upsertProviderInYaml(
      {
        key: "figma",
        displayName: "Figma Renamed",
        adapter: "atlassian-statuspage",
        baseUrl: "https://status.figma.com",
      },
      configPath,
    );
    expect(result.created).toBe(false);

    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("displayName: Figma Renamed");
    expect(after).toContain("# Bitbucket: Atlassian Statuspage");
  });

  it("removes a provider and reports false when key missing", () => {
    expect(removeProviderFromYaml("figma", configPath)).toBe(true);
    expect(readFileSync(configPath, "utf-8")).not.toContain("key: figma");
    expect(removeProviderFromYaml("does-not-exist", configPath)).toBe(false);
  });

  it("allows removing the last provider — empty list is a valid config", () => {
    const oneEntry = join(dir, "single.yaml");
    writeFileSync(
      oneEntry,
      `chatTarget: googleChat
providers:
  - key: only
    displayName: Only
    adapter: atlassian-statuspage
    baseUrl: https://example.com
`,
      "utf-8",
    );
    expect(removeProviderFromYaml("only", oneEntry)).toBe(true);
    expect(readFileSync(oneEntry, "utf-8")).not.toContain("key: only");
  });

  it("throws when the target file does not exist", () => {
    expect(() => removeProviderFromYaml("any", join(dir, "missing.yaml"))).toThrow();
  });

  it("preserves YAML anchors used in unaffected entries", () => {
    const yamlWithAnchors = `chatTarget: googleChat
providers:
  - &shared-ua
    key: bitbucket
    displayName: Bitbucket
    adapter: atlassian-statuspage
    baseUrl: https://bitbucket.status.atlassian.com
    userAgent: shared-ua/1.0

  - key: figma
    displayName: Figma
    adapter: atlassian-statuspage
    baseUrl: https://status.figma.com
`;
    const anchored = join(dir, "anchored.yaml");
    writeFileSync(anchored, yamlWithAnchors, "utf-8");

    upsertProviderInYaml(
      {
        key: "webflow",
        displayName: "Webflow",
        adapter: "atlassian-statuspage",
        baseUrl: "https://status.webflow.com",
      },
      anchored,
    );

    const after = readFileSync(anchored, "utf-8");
    expect(after).toContain("&shared-ua");
    expect(after).toContain("key: webflow");
  });

  it("rejects an upsert with an invalid adapter/baseUrl combination", () => {
    expect(() =>
      upsertProviderInYaml(
        {
          key: "bad",
          displayName: "Bad",
          adapter: "atlassian-statuspage",
          // baseUrl missing
        } as never,
        configPath,
      ),
    ).toThrow();
  });
});
