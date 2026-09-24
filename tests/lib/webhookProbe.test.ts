import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:tls", () => ({ connect: vi.fn() }));

import { connect } from "node:tls";
import { probeWebhookReachability } from "../../src/lib/webhookProbe.js";

const mockedConnect = vi.mocked(connect);

/** Fake TLS socket that emits `event` on the next tick. */
function fakeSocket(event: "secureConnect" | "timeout" | "error") {
  const socket = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  setImmediate(() => socket.emit(event, new Error("ECONNREFUSED")));
  return socket;
}

describe("probeWebhookReachability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves after the TLS handshake and closes the socket without writing", async () => {
    const socket = fakeSocket("secureConnect");
    mockedConnect.mockReturnValue(socket as never);

    await probeWebhookReachability("https://prod.logic.example/workflows/x?sig=secret");

    expect(mockedConnect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "prod.logic.example", port: 443 }),
    );
    expect(socket.end).toHaveBeenCalledWith();
  });

  it("rejects on a handshake error without leaking the SAS signature", async () => {
    mockedConnect.mockReturnValue(fakeSocket("error") as never);

    const err = await probeWebhookReachability("https://h.example/x?sig=secret").catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/failed: ECONNREFUSED/);
    expect((err as Error).message).not.toMatch(/secret/);
  });

  it("rejects on timeout", async () => {
    mockedConnect.mockReturnValue(fakeSocket("timeout") as never);
    await expect(probeWebhookReachability("https://h.example/x")).rejects.toThrow(/timed out/);
  });

  it("refuses non-https URLs", async () => {
    await expect(probeWebhookReachability("http://h.example/x")).rejects.toThrow(/protocol/);
    expect(mockedConnect).not.toHaveBeenCalled();
  });
});
