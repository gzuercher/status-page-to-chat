import pino from "pino";

/**
 * Central logger for the entire application.
 * Emits structured JSON to stdout; in the containerised deployment this
 * is captured by the Docker logging driver.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Defense in depth: never leak the webhook URL or related error fields
  // into structured logs, even if a future code path passes them in.
  redact: {
    paths: [
      "webhookUrl",
      "*.webhookUrl",
      "err.url",
      "err.input",
      "err.config.url",
      "err.cause.url",
      "err.cause.input",
      "err.cause.config.url",
    ],
    censor: "[redacted]",
  },
});
