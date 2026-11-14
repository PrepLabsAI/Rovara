import { Socket } from "node:net";
import { afterAll, beforeAll, vi } from "vitest";
// Stronger than the required non-loopback guard: this pure detector needs no sockets, including loopback.
beforeAll(() => {
  vi.stubGlobal("fetch", () => { throw new Error("network forbidden"); });
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw new Error("network forbidden"); });
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
