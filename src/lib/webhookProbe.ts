import { connect } from "node:tls";

/** Same per-attempt budget as the shared httpClient. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Checks that the webhook host is reachable — DNS, TCP and a completed TLS
 * handshake — without sending an HTTP request.
 *
 * Why not a request: the Logic App's HTTP trigger accepts every method and
 * does not enforce its body schema, so ANY request to the trigger URL
 * starts a workflow run. The previous probe (an empty `{}` POST) therefore
 * produced a run with an empty body every hour from 2026-09-22 22:45 UTC
 * on. A handshake stops short of the trigger and still covers exactly what
 * the 2026-09-20 outage broke: a connect timeout, i.e. no response at all.
 *
 * Only host and port are used; the path and its SAS signature never leave
 * this process and are never logged.
 */
export function probeWebhookReachability(webhookUrl: string): Promise<void> {
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:") {
    return Promise.reject(new Error(`Unsupported webhook protocol: ${url.protocol}`));
  }
  const host = url.hostname;
  const port = url.port ? Number(url.port) : 443;

  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host, timeout: PROBE_TIMEOUT_MS });
    socket.once("secureConnect", () => {
      socket.end();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`TLS handshake with ${host}:${port} timed out`));
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(new Error(`TLS handshake with ${host}:${port} failed: ${err.message}`));
    });
  });
}
