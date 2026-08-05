import { describe, expect, it } from "vitest";
import { faviconUrlForHost, normalizeLogoUrl, resolveProviderLogoUrl } from "../../src/lib/logo.js";

describe("faviconUrlForHost", () => {
  it("addresses the redirect-free faviconV2 endpoint", () => {
    const url = faviconUrlForHost("status.claude.com");
    expect(url.startsWith("https://t0.gstatic.com/faviconV2?")).toBe(true);
    // The legacy endpoint answers 301 and Teams does not follow it.
    expect(url).not.toContain("www.google.com/s2/favicons");
  });

  it("requests the host over https at 64px with a synthesised fallback", () => {
    const params = new URL(faviconUrlForHost("status.zendesk.com")).searchParams;
    expect(params.get("url")).toBe("https://status.zendesk.com");
    expect(params.get("size")).toBe("64");
    // Without fallback_opts this domain answers 404 — see lessons.md.
    expect(params.get("fallback_opts")).toBe("TYPE,SIZE,URL");
  });

  it("percent-encodes hosts instead of interpolating them raw", () => {
    const params = new URL(faviconUrlForHost("a b.example.com")).searchParams;
    expect(params.get("url")).toBe("https://a b.example.com");
  });
});

describe("normalizeLogoUrl", () => {
  it("upgrades a legacy s2/favicons URL to the redirect-free form", () => {
    const upgraded = normalizeLogoUrl(
      "https://www.google.com/s2/favicons?domain=zendesk.com&sz=64",
    );
    expect(upgraded).toBe(faviconUrlForHost("zendesk.com"));
  });

  it("accepts a full URL in the legacy domain parameter", () => {
    const upgraded = normalizeLogoUrl(
      "https://www.google.com/s2/favicons?domain=https://wedos.cz/path&sz=64",
    );
    expect(upgraded).toBe(faviconUrlForHost("wedos.cz"));
  });

  it("leaves an operator's own logo URL untouched", () => {
    const custom = "https://cdn.raptus.ch/logos/bexio.png";
    expect(normalizeLogoUrl(custom)).toBe(custom);
  });

  it("leaves a legacy URL without a domain parameter untouched", () => {
    const odd = "https://www.google.com/s2/favicons?sz=64";
    expect(normalizeLogoUrl(odd)).toBe(odd);
  });

  it("returns non-URL input verbatim rather than throwing", () => {
    expect(normalizeLogoUrl("not a url")).toBe("not a url");
  });
});

describe("resolveProviderLogoUrl", () => {
  it("normalises an explicit legacy logoUrl from the deployed config", () => {
    // Verbatim from the production providers.yaml before this fix.
    const resolved = resolveProviderLogoUrl({
      explicitLogoUrl: "https://www.google.com/s2/favicons?domain=wedos.cz&sz=64",
      baseUrl: "https://wedos.status.online",
    });
    expect(resolved).toBe(faviconUrlForHost("wedos.cz"));
  });

  it("prefers an explicit logo over the baseUrl host", () => {
    const resolved = resolveProviderLogoUrl({
      explicitLogoUrl: "https://cdn.raptus.ch/logo.png",
      baseUrl: "https://status.example.com",
    });
    expect(resolved).toBe("https://cdn.raptus.ch/logo.png");
  });

  it("derives the favicon from the baseUrl host when no logo is configured", () => {
    const resolved = resolveProviderLogoUrl({ baseUrl: "https://www.cloudflarestatus.com/" });
    expect(resolved).toBe(faviconUrlForHost("www.cloudflarestatus.com"));
  });

  it("returns undefined without a baseUrl (e.g. github-issues providers)", () => {
    expect(resolveProviderLogoUrl({})).toBeUndefined();
  });

  it("returns undefined for an unparseable baseUrl", () => {
    expect(resolveProviderLogoUrl({ baseUrl: "not a url" })).toBeUndefined();
  });
});
