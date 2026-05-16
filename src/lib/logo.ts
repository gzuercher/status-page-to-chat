/**
 * Builds a Google-favicon URL for a given host. Used as the default logo
 * source when a provider does not specify an explicit `logoUrl`.
 *
 * Sized at 64px so high-DPI clients render crisply; Google downscales when
 * the source favicon is smaller.
 */
export function faviconUrlForHost(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/**
 * Resolves the brand logo URL for a provider.
 *
 *   1. If `explicitLogoUrl` is set in the provider config, use it verbatim.
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
  if (opts.explicitLogoUrl) return opts.explicitLogoUrl;
  if (!opts.baseUrl) return undefined;
  try {
    const host = new URL(opts.baseUrl).hostname;
    if (!host) return undefined;
    return faviconUrlForHost(host);
  } catch {
    return undefined;
  }
}
