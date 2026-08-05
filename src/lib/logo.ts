/**
 * Brand-logo resolution for provider cards.
 *
 * Logos are favicons fetched by the *chat client* (Teams renders the
 * Adaptive Card image itself), so the URL we emit must be something a
 * plain image loader can resolve in one hop. Two properties matter:
 *
 *   1. **No redirect.** `https://www.google.com/s2/favicons?domain=…`
 *      answers `301` to `https://t{0..3}.gstatic.com/faviconV2?…`.
 *      Teams does not follow that cross-origin hop and renders a broken
 *      image instead. We therefore address the redirect *target*
 *      directly — same service, same bytes, but `200` in one request.
 *   2. **No 404.** The legacy endpoint answers `404` (with a 726-byte
 *      placeholder body) for domains it has never crawled, e.g.
 *      `status.zendesk.com` and `wedos.status.online`. faviconV2 with
 *      `fallback_opts` returns `200` and a real icon for those.
 *
 * See lessons.md (2026-08-05) for the measurements behind this.
 */

/**
 * Google's faviconV2 endpoint — the documented redirect target of the
 * older `/s2/favicons` URL. `t0` is one of four interchangeable
 * round-robin hosts (`t0`–`t3`); we pin one so the URL stays stable and
 * cacheable rather than varying per call.
 */
const FAVICON_ENDPOINT = "https://t0.gstatic.com/faviconV2";

/** Rendered at 64px so high-DPI clients stay crisp; the service upscales. */
const FAVICON_SIZE = 64;

/**
 * Builds a favicon URL for a given host. Used as the default logo source
 * when a provider does not specify an explicit `logoUrl`.
 *
 * `fallback_opts=TYPE,SIZE,URL` makes the service synthesise an icon
 * when the host publishes none, which is what keeps the response a 200
 * for obscure status subdomains.
 */
export function faviconUrlForHost(host: string): string {
  const params = new URLSearchParams({
    client: "SOCIAL",
    type: "FAVICON",
    fallback_opts: "TYPE,SIZE,URL",
    size: String(FAVICON_SIZE),
    url: `https://${host}`,
  });
  return `${FAVICON_ENDPOINT}?${params.toString()}`;
}

/**
 * Upgrades a legacy `www.google.com/s2/favicons` URL to the redirect-free
 * form. Applied to operator-authored `logoUrl` values so configs written
 * before this fix keep working without an edit — the deployed
 * providers.yaml carries several of them.
 *
 * Anything else is returned verbatim: an operator who points at their own
 * CDN must get exactly what they configured.
 */
export function normalizeLogoUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL we can reason about — hand it back untouched and let the
    // notifier deal with it.
    return url;
  }
  if (parsed.hostname !== "www.google.com" || !parsed.pathname.startsWith("/s2/favicons")) {
    return url;
  }
  const domain = parsed.searchParams.get("domain");
  if (!domain) return url;
  return faviconUrlForHost(hostOf(domain));
}

/**
 * Extracts a bare hostname. The `domain` parameter of the legacy endpoint
 * accepts both `example.com` and `https://example.com/path`.
 */
function hostOf(domainOrUrl: string): string {
  if (!domainOrUrl.includes("://")) return domainOrUrl;
  try {
    return new URL(domainOrUrl).hostname || domainOrUrl;
  } catch {
    return domainOrUrl;
  }
}

/**
 * Resolves the brand logo URL for a provider.
 *
 *   1. If `explicitLogoUrl` is set in the provider config, use it —
 *      normalised, so a legacy favicon URL is silently upgraded.
 *   2. Otherwise derive a favicon from `baseUrl`'s host.
 *   3. If neither is available (e.g. github-issues without explicit logo),
 *      return undefined and let the notifier render the card without a logo.
 *
 * We deliberately do NOT derive from the per-incident URL: Atlassian's
 * shortlinks resolve to stspg.io (Statuspage's own brand) and GitHub-issue
 * URLs always resolve to github.com — both would mask the actual provider.
 */
export function resolveProviderLogoUrl(opts: {
  explicitLogoUrl?: string;
  baseUrl?: string;
}): string | undefined {
  if (opts.explicitLogoUrl) return normalizeLogoUrl(opts.explicitLogoUrl);
  if (!opts.baseUrl) return undefined;
  try {
    const host = new URL(opts.baseUrl).hostname;
    if (!host) return undefined;
    return faviconUrlForHost(host);
  } catch {
    return undefined;
  }
}
