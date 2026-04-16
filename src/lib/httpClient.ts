import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetch, type RequestInit } from "undici";
import { logger } from "./logger.js";

/** Timeout for all outgoing HTTP requests (10 seconds). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Determines the default User-Agent from package.json.
 * Format: raptus-status-monitor/<version> (+https://github.com/raptus/status-page-to-chat; ops@raptus.ch)
 */
function getDefaultUserAgent(): string {
  if (process.env.USER_AGENT) {
    return process.env.USER_AGENT;
  }
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8")) as {
      version: string;
    };
    return `raptus-status-monitor/${pkg.version} (+https://github.com/raptus/status-page-to-chat; ops@raptus.ch)`;
  } catch {
    return "raptus-status-monitor/0.0.0 (+https://github.com/raptus/status-page-to-chat; ops@raptus.ch)";
  }
}

let cachedUserAgent: string | undefined;

function getUserAgent(): string {
  if (!cachedUserAgent) {
    cachedUserAgent = getDefaultUserAgent();
  }
  return cachedUserAgent;
}

export type HttpResponse = {
  status: number;
  contentType: string;
  body: string;
};

/**
 * Central HTTP client for all adapters.
 * Sets User-Agent and timeout uniformly.
 */
export async function httpGet(
  url: string,
  options?: {
    accept?: string;
    userAgent?: string;
    headers?: Record<string, string>;
  },
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const init: RequestInit = {
    method: "GET",
    signal: controller.signal,
    headers: {
      "User-Agent": options?.userAgent ?? getUserAgent(),
      ...(options?.accept ? { Accept: options.accept } : {}),
      ...options?.headers,
    },
  };

  try {
    const response = await fetch(url, init);
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";

    logger.debug({ url, status: response.status, contentType }, "HTTP GET completed");

    return {
      status: response.status,
      contentType,
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * HTTP POST for notifiers (webhooks).
 */
export async function httpPost(
  url: string,
  payload: unknown,
  options?: {
    userAgent?: string;
    contentType?: string;
  },
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const init: RequestInit = {
    method: "POST",
    signal: controller.signal,
    headers: {
      "User-Agent": options?.userAgent ?? getUserAgent(),
      "Content-Type": options?.contentType ?? "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  };

  try {
    const response = await fetch(url, init);
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";

    return {
      status: response.status,
      contentType,
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}
