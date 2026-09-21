import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadCheckCentralConfig, sendCheckin } from "../../src/lib/checkcentralMailer.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }));

vi.mock("nodemailer", () => ({
  default: { createTransport: (...args: unknown[]) => createTransport(...args) },
}));

function clearEnv(): void {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USERNAME;
  delete process.env.SMTP_PASSWORD;
  delete process.env.CHECKCENTRAL_FROM_EMAIL;
  delete process.env.CHECKCENTRAL_TO_EMAIL;
}

describe("loadCheckCentralConfig", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("returns undefined when nothing is configured", () => {
    expect(loadCheckCentralConfig()).toBeUndefined();
  });

  it("returns undefined and warns when only some values are set", () => {
    process.env.SMTP_HOST = "smtp.azurecomm.net";
    process.env.SMTP_USERNAME = "acs-user";
    // SMTP_PASSWORD, CHECKCENTRAL_FROM_EMAIL, CHECKCENTRAL_TO_EMAIL missing.
    expect(loadCheckCentralConfig()).toBeUndefined();
  });

  it("returns a full config once every required value is set", () => {
    process.env.SMTP_HOST = "smtp.azurecomm.net";
    process.env.SMTP_USERNAME = "acs-user";
    process.env.SMTP_PASSWORD = "secret";
    process.env.CHECKCENTRAL_FROM_EMAIL = "hostmaster@raptus.com";
    process.env.CHECKCENTRAL_TO_EMAIL = "raptus+internal-it@mycheckcentral.cc";

    const config = loadCheckCentralConfig();
    expect(config).toMatchObject({
      smtpHost: "smtp.azurecomm.net",
      smtpPort: 587,
      smtpUsername: "acs-user",
      fromEmail: "hostmaster@raptus.com",
      toEmail: "raptus+internal-it@mycheckcentral.cc",
    });
  });

  it("respects an explicit SMTP_PORT instead of the 587 default", () => {
    process.env.SMTP_HOST = "smtp.azurecomm.net";
    process.env.SMTP_PORT = "2525";
    process.env.SMTP_USERNAME = "acs-user";
    process.env.SMTP_PASSWORD = "secret";
    process.env.CHECKCENTRAL_FROM_EMAIL = "hostmaster@raptus.com";
    process.env.CHECKCENTRAL_TO_EMAIL = "raptus+internal-it@mycheckcentral.cc";

    expect(loadCheckCentralConfig()?.smtpPort).toBe(2525);
  });
});

describe("sendCheckin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a plain-text mail to the configured recipient with the given subject", async () => {
    sendMail.mockResolvedValueOnce(undefined);
    const config = {
      smtpHost: "smtp.azurecomm.net",
      smtpPort: 587,
      smtpUsername: "acs-user",
      smtpPassword: "secret",
      fromEmail: "hostmaster@raptus.com",
      toEmail: "raptus+internal-it@mycheckcentral.cc",
    };

    await sendCheckin(config, "Status Page Poller — Poll", "STATUS: OK");

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.azurecomm.net",
        port: 587,
        secure: false,
        auth: { user: "acs-user", pass: "secret" },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "hostmaster@raptus.com",
        to: "raptus+internal-it@mycheckcentral.cc",
        subject: "Status Page Poller — Poll",
        text: expect.stringContaining("STATUS: OK"),
      }),
    );
  });

  it("propagates an SMTP failure to the caller", async () => {
    sendMail.mockRejectedValueOnce(new Error("SMTP AUTH failed"));
    const config = {
      smtpHost: "smtp.azurecomm.net",
      smtpPort: 587,
      smtpUsername: "acs-user",
      smtpPassword: "wrong",
      fromEmail: "hostmaster@raptus.com",
      toEmail: "raptus+internal-it@mycheckcentral.cc",
    };

    await expect(
      sendCheckin(config, "Status Page Poller — Delivery", "STATUS: OK"),
    ).rejects.toThrow("SMTP AUTH failed");
  });
});
