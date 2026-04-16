import pino from "pino";

/**
 * Zentraler Logger fuer die gesamte Anwendung.
 * In Azure wird der Output von Application Insights erfasst.
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
