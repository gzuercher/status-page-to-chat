import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCheckCentralTest } from "../../src/cli/checkcentralTest.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock("../../src/lib/checkcentralMailer.js", () => ({
  loadCheckCentralConfig: vi.fn(),
  sendCheckin: vi.fn(),
}));

import { loadCheckCentralConfig, sendCheckin } from "../../src/lib/checkcentralMailer.js";

const mockedLoadCheckCentralConfig = vi.mocked(loadCheckCentralConfig);
const mockedSendCheckin = vi.mocked(sendCheckin);

const FAKE_CONFIG = {
  smtpHost: "smtp.azurecomm.net",
  smtpPort: 587,
  smtpUsername: "acs-user",
  smtpPassword: "secret",
  fromEmail: "hostmaster@raptus.com",
  toEmail: "raptus+internal-it@mycheckcentral.cc",
};

describe("runCheckCentralTest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends one check-in with STATUS: OK, marked as a manual test", async () => {
    mockedLoadCheckCentralConfig.mockReturnValue(FAKE_CONFIG);
    mockedSendCheckin.mockResolvedValue(undefined);

    await runCheckCentralTest();

    expect(mockedSendCheckin).toHaveBeenCalledOnce();
    const [config, subject, statusLine] = mockedSendCheckin.mock.calls[0];
    expect(config).toBe(FAKE_CONFIG);
    expect(subject).toBe("Status Page Poller — Health");
    expect(statusLine).toMatch(/^STATUS: OK/);
    expect(statusLine).toMatch(/manual test/i);
  });

  it("exits 1 with a readable message when CheckCentral is not configured", async () => {
    mockedLoadCheckCentralConfig.mockReturnValue(undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCheckCentralTest();

    expect(mockedSendCheckin).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy.mock.calls[0][0]).toMatch(/not configured/i);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("propagates an SMTP failure to the caller", async () => {
    mockedLoadCheckCentralConfig.mockReturnValue(FAKE_CONFIG);
    mockedSendCheckin.mockRejectedValue(new Error("SMTP AUTH failed"));

    await expect(runCheckCentralTest()).rejects.toThrow("SMTP AUTH failed");
  });
});
