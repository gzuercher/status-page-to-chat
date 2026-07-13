/**
 * GESPIEGELTES MODUL (Familienstandard mit social-to-chat).
 * Änderungen hier bitte im Schwester-Repo nachziehen.
 *
 * Maps an unknown adapter error into a single short category string
 * suitable for end-user display in chat. The goal is to give operators
 * just enough signal to know whether to investigate now or wait, without
 * leaking stack traces, URLs, or library jargon into Teams.
 *
 * Examples: "Authentication failed", "HTTP 404", "Timeout",
 * "DNS lookup failed", "Connection refused", "Invalid response format",
 * "Unknown error".
 */
export function categorizeError(err: unknown): string {
  const message = extractMessage(err);

  const httpMatch = message.match(/HTTP (\d{3})/);
  if (httpMatch) {
    // 401/403 gesondert: bei Token-basierten APIs (z. B. github-issues mit
    // GITHUB_TOKEN) oder WAF-geschützten Seiten ist das fast immer ein
    // abgelaufenes/entzogenes Token — der Operator soll das sofort erkennen.
    if (httpMatch[1] === "401" || httpMatch[1] === "403") return "Authentication failed";
    return `HTTP ${httpMatch[1]}`;
  }

  if (/abort|timeout|timed out|deadline/i.test(message)) return "Timeout";

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return "DNS lookup failed";
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(message))
    return "Connection refused";
  if (/CERT_|certificate|self.signed/i.test(message)) return "TLS certificate error";

  if (
    /JSON parsing failed|XML parsing failed|Unexpected token|Unexpected Content-Type/i.test(message)
  )
    return "Invalid response format";

  return "Unknown error";
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return "";
}
