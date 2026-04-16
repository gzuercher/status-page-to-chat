import pino from "pino";

/**
 * Central logger for the entire application.
 * In Azure the output is captured by Application Insights.
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
