import { describe, it, expect } from "vitest";
import { categorizeError } from "../../src/lib/errorCategory.js";

describe("categorizeError", () => {
  it("extracts HTTP status from typical adapter error messages", () => {
    expect(categorizeError(new Error("HTTP 404 from https://status.example.com/api"))).toBe(
      "HTTP 404",
    );
    expect(categorizeError(new Error("HTTP 503: service unavailable"))).toBe("HTTP 503");
  });

  it("classifies fetch timeouts as Timeout", () => {
    expect(categorizeError(new Error("The operation was aborted due to timeout"))).toBe("Timeout");
    expect(categorizeError({ name: "AbortError", message: "request aborted" })).toBe("Timeout");
  });

  it("classifies DNS failures and connection errors distinctly", () => {
    expect(categorizeError(new Error("getaddrinfo ENOTFOUND status.example.com"))).toBe(
      "DNS lookup failed",
    );
    expect(categorizeError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(
      "Connection refused",
    );
  });

  it("rolls JSON / XML / Content-Type parse failures into a single bucket", () => {
    expect(categorizeError(new Error("JSON parsing failed: SyntaxError"))).toBe(
      "Invalid response format",
    );
    expect(categorizeError(new Error("XML parsing failed"))).toBe("Invalid response format");
    expect(
      categorizeError(new Error('Unexpected Content-Type "text/html" from /api/v2/incidents.json')),
    ).toBe("Invalid response format");
  });

  it("falls back to Unknown error for unrecognised messages", () => {
    expect(categorizeError(new Error("everything is on fire"))).toBe("Unknown error");
    expect(categorizeError(undefined)).toBe("Unknown error");
    expect(categorizeError(null)).toBe("Unknown error");
  });
});
