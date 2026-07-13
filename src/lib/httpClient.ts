import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetch, type RequestInit } from "undici";
import { logger } from "./logger.js";

/**
 * GESPIEGELTES MODUL (Familienstandard mit social-to-chat).
 * Änderungen hier bitte im Schwester-Repo nachziehen — nur die
 * REPO_URL-Konstante ist repo-spezifisch.
 *
 * Zentraler HTTP-Client für alle Adapter und Notifier:
 *   • einheitlicher Timeout pro Versuch (10 s, AbortController)
 *   • einheitlicher User-Agent (aus package.json, überschreibbar via USER_AGENT)
 *   • Retry mit exponentiellem Backoff für 429/5xx/Netzwerkfehler,
 *     `Retry-After` wird respektiert (gedeckelt)
 *
 * Semantik ist at-least-once: auch POSTs werden wiederholt. Doppelte
 * Zustellungen fängt die Dedup-Schicht des Aufrufers ab (der State-Store
 * dedupliziert Incidents pro Provider, bevor ein Notifier aufgerufen wird).
 */

/** Timeout je Versuch (nicht gesamt). */
const REQUEST_TIMEOUT_MS = 10_000;

/** Wiederholungen nach dem Erstversuch. */
const DEFAULT_RETRIES = 2;

/** Backoff: BASE × FACTOR^attempt → 1 s, 4 s. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_FACTOR = 4;

/** Obergrenze für Backoff bzw. serverseitiges Retry-After. */
const BACKOFF_CAP_MS = 30_000;

/** Repo-spezifisch (einziger erlaubter Unterschied zum Schwester-Repo). */
const REPO_URL = "https://github.com/gzuercher/status-page-to-chat";

function getDefaultUserAgent(): string {
  if (process.env.USER_AGENT) return process.env.USER_AGENT;
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8")) as {
      name: string;
      version: string;
    };
    return `${pkg.name}/${pkg.version} (+${REPO_URL})`;
  } catch {
    return `status-page-to-chat/0.0.0 (+${REPO_URL})`;
  }
}

let cachedUserAgent: string | undefined;

function getUserAgent(): string {
  cachedUserAgent ??= getDefaultUserAgent();
  return cachedUserAgent;
}

export type HttpResponse = {
  status: number;
  contentType: string;
  body: string;
};

export type HttpOptions = {
  accept?: string;
  userAgent?: string;
  /** Zusätzliche Header, z. B. Authorization / API-Key. Werden nach den Defaults gemerged. */
  headers?: Record<string, string>;
  /** Wiederholungen nach dem Erstversuch (Default 2). 0 = keine Retries. */
  retries?: number;
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Liest Retry-After (Sekunden oder HTTP-Datum) und deckelt auf BACKOFF_CAP_MS. */
function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, BACKOFF_CAP_MS);
  const dateMs = Date.parse(headerValue) - Date.now();
  if (Number.isFinite(dateMs)) return Math.min(Math.max(dateMs, 0), BACKOFF_CAP_MS);
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function attemptOnce(
  url: string,
  init: RequestInit,
): Promise<HttpResponse & { retryAfterMs?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
      retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Führt den Request aus und wiederholt bei 429/5xx/Netzwerkfehlern mit
 * exponentiellem Backoff. Nicht-retrybare Antworten (2xx–4xx außer 429)
 * werden unverändert zurückgegeben — Statuscode-Behandlung ist Sache des
 * Aufrufers.
 */
async function requestWithRetry(
  url: string,
  init: RequestInit,
  retries: number,
): Promise<HttpResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfterMs: number | undefined;
    try {
      const { retryAfterMs: serverDelay, ...response } = await attemptOnce(url, init);
      if (!isRetryableStatus(response.status) || attempt === retries) {
        return response;
      }
      retryAfterMs = serverDelay;
      logger.debug(
        { url, status: response.status, attempt },
        "HTTP request returned retryable status, backing off",
      );
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
      logger.debug({ url, err, attempt }, "HTTP request failed, backing off");
    }
    const backoff = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** attempt, BACKOFF_CAP_MS);
    await sleep(retryAfterMs ?? backoff);
  }
  // Unerreichbar (Schleife returned oder wirft), hält aber TS zufrieden.
  throw lastError instanceof Error ? lastError : new Error("HTTP request failed");
}

/**
 * HTTP GET für Adapter (Status-Page-APIs).
 */
export async function httpGet(url: string, options?: HttpOptions): Promise<HttpResponse> {
  const response = await requestWithRetry(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": options?.userAgent ?? getUserAgent(),
        ...(options?.accept ? { Accept: options.accept } : {}),
        ...options?.headers,
      },
    },
    options?.retries ?? DEFAULT_RETRIES,
  );
  logger.debug({ url, status: response.status }, "HTTP GET completed");
  return response;
}

/**
 * HTTP POST für Notifier (Webhooks).
 */
export async function httpPost(
  url: string,
  payload: unknown,
  options?: HttpOptions & { contentType?: string },
): Promise<HttpResponse> {
  return requestWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "User-Agent": options?.userAgent ?? getUserAgent(),
        "Content-Type": options?.contentType ?? "application/json; charset=utf-8",
        ...options?.headers,
      },
      body: JSON.stringify(payload),
    },
    options?.retries ?? DEFAULT_RETRIES,
  );
}
