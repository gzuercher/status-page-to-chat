import nodemailer from "nodemailer";
import { logger } from "./logger.js";

/**
 * Sends dead-man's-switch check-in emails to CheckCentral (a mailbox
 * monitor: it flags a check as failed when no matching email arrives
 * within its configured window, rather than us calling an HTTP endpoint).
 *
 * This is a deliberately separate, minimal alerting channel from the chat
 * webhook (see docs/DEPLOYMENT.md#self-monitoring) — a watchdog must not
 * depend on the thing it watches, so this goes out over SMTP, not the
 * Logic App path. It is entirely optional: with no SMTP/CheckCentral env
 * vars set, `isConfigured()` is false and main.ts skips it silently.
 */

export type CheckCentralConfig = {
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  fromEmail: string;
  toEmail: string;
};

/**
 * Reads the CheckCentral/SMTP config from the environment. All six values
 * are required together — a partially-set config almost certainly means a
 * typo'd env var name, not an intentionally half-enabled feature, so it is
 * reported once as a warning rather than silently sending nothing or
 * crashing the poll loop.
 */
export function loadCheckCentralConfig(): CheckCentralConfig | undefined {
  // SMTP_PORT is the one field with a sensible default (587, the standard
  // STARTTLS submission port) — everything else is deployment-specific
  // with no safe guess, so it is required together with the rest.
  const raw: Record<string, string | undefined> = {
    smtpHost: process.env.SMTP_HOST,
    smtpUsername: process.env.SMTP_USERNAME,
    smtpPassword: process.env.SMTP_PASSWORD,
    fromEmail: process.env.CHECKCENTRAL_FROM_EMAIL,
    toEmail: process.env.CHECKCENTRAL_TO_EMAIL,
  };
  const missing = Object.entries(raw)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length === Object.keys(raw).length) return undefined;
  if (missing.length > 0) {
    logger.warn(
      { missing },
      "CheckCentral partially configured — all of SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD/CHECKCENTRAL_FROM_EMAIL/CHECKCENTRAL_TO_EMAIL are required together; check-ins disabled",
    );
    return undefined;
  }
  return {
    smtpHost: raw.smtpHost as string,
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpUsername: raw.smtpUsername as string,
    smtpPassword: raw.smtpPassword as string,
    fromEmail: raw.fromEmail as string,
    toEmail: raw.toEmail as string,
  };
}

let cachedTransport: ReturnType<typeof nodemailer.createTransport> | undefined;
let cachedForConfig: CheckCentralConfig | undefined;

function transportFor(config: CheckCentralConfig): ReturnType<typeof nodemailer.createTransport> {
  // Rebuilt only when the config actually changes (e.g. a live config
  // reload picked up new values) — creating a transport per send would
  // needlessly reconnect every cycle.
  if (cachedTransport && cachedForConfig === config) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // STARTTLS on 587 (Azure Communication Services' SMTP relay), not
    // implicit TLS — nodemailer negotiates it automatically when the
    // server advertises STARTTLS and `secure` is false.
    secure: false,
    auth: { user: config.smtpUsername, pass: config.smtpPassword },
  });
  cachedForConfig = config;
  return cachedTransport;
}

/**
 * Sends one check-in email. `subject` must match what the corresponding
 * CheckCentral check's matching_conditions expect — see
 * docs/DEPLOYMENT.md#self-monitoring for the exact values configured for
 * this deployment. Throws on any SMTP failure; the caller decides what
 * that means (see main.ts's check-in gating, which only advances its
 * "last sent" timestamp on success — a resettable service must not act
 * like it announced its own good health when it did not).
 */
export async function sendCheckin(
  config: CheckCentralConfig,
  subject: string,
  statusLine: string,
): Promise<void> {
  const transport = transportFor(config);
  await transport.sendMail({
    from: config.fromEmail,
    to: config.toEmail,
    subject,
    text: `${statusLine}\n\nSent ${new Date().toISOString()}`,
  });
}
