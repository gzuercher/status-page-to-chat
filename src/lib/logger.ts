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
});
