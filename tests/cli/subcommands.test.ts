import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const MAIN_JS = resolve(__dirname, "../../dist/src/main.js");

const VALID_YAML = `chatTarget: googleChat
providers:
  - key: bitbucket
    displayName: Bitbucket
    adapter: atlassian-statuspage
    baseUrl: https://bitbucket.status.atlassian.com
`;

const INVALID_YAML = `chatTarget: googleChat
providers: []
`;

const BROKEN_YAML = `chatTarget: googleChat
providers:
  -- invalid yaml here
`;

let dir: string;

beforeAll(() => {
  // dist/src/main.js must exist — vitest does not run pnpm build for us.
  if (!existsSync(MAIN_JS)) {
    throw new Error(`Build artifact not found at ${MAIN_JS}. Run \`pnpm build\` first.`);
  }
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCli(
  args: string[],
  env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [MAIN_JS, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("CLI subcommands", () => {
  describe("validate", () => {
    it("returns 0 on a valid config", () => {
      const configPath = join(dir, "providers.yaml");
      writeFileSync(configPath, VALID_YAML, "utf-8");
      const r = runCli(["validate"], { CONFIG_PATH: configPath });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^OK/);
    });

    it("returns 1 with a readable error on schema violation", () => {
      const configPath = join(dir, "providers.yaml");
      writeFileSync(configPath, INVALID_YAML, "utf-8");
      const r = runCli(["validate"], { CONFIG_PATH: configPath });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/invalid/i);
    });

    it("returns 1 when the YAML is unparseable", () => {
      const configPath = join(dir, "providers.yaml");
      writeFileSync(configPath, BROKEN_YAML, "utf-8");
      const r = runCli(["validate"], { CONFIG_PATH: configPath });
      expect(r.code).toBe(1);
      // Either "parse" or "validate" kind depending on YAML parser strictness
      expect(r.stderr).toMatch(/invalid \((parse|validate|read)\)/);
    });

    it("returns 1 when the file does not exist", () => {
      const r = runCli(["validate"], { CONFIG_PATH: join(dir, "missing.yaml") });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/could not be loaded/);
    });
  });

  describe("health", () => {
    it("reports 'warming up' (exit 0) when no poll has completed", () => {
      const dbPath = join(dir, "state.sqlite");
      const r = runCli(["health"], { STATE_DB_PATH: dbPath });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/warming up/);
    });

    it("reports healthy when last_run_at is fresh", () => {
      const dbPath = join(dir, "state.sqlite");
      // Pre-seed the database with a recent timestamp.
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE metadata (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);`);
      db.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)`).run(
        "last_run_at",
        new Date(Date.now() - 30_000).toISOString(),
      );
      db.close();

      const r = runCli(["health"], { STATE_DB_PATH: dbPath });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/healthy: last poll was \d+s ago/);
    });

    it("reports unhealthy when last_run_at exceeds the threshold", () => {
      const dbPath = join(dir, "state.sqlite");
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE metadata (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);`);
      db.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)`).run(
        "last_run_at",
        new Date(Date.now() - 3_600_000).toISOString(),
      );
      db.close();

      const r = runCli(["health"], {
        STATE_DB_PATH: dbPath,
        HEALTH_MAX_AGE_SECONDS: "900",
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/unhealthy/);
    });
  });

  describe("unknown subcommand", () => {
    it("exits 2 with usage text", () => {
      const r = runCli(["bogus"], {});
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/Usage:/);
    });
  });
});
