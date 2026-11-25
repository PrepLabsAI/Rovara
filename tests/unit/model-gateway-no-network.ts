import { afterAll, vi } from "vitest";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
/** Installed in beforeAll; restored after this file. No real transport, even loopback. */
export function denyNetwork(): void {
  const denied = (): never => { throw new Error("NetworkAttempt"); };
  const mocks: Array<{ mockRestore(): void }> = [vi.spyOn(globalThis, "fetch").mockImplementation(denied), vi.spyOn(net.Socket.prototype, "connect").mockImplementation(denied),
    vi.spyOn(http, "request").mockImplementation(denied), vi.spyOn(http, "get").mockImplementation(denied),
    vi.spyOn(https, "request").mockImplementation(denied), vi.spyOn(https, "get").mockImplementation(denied)];
  for (const api of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    const names = new Set<string>(); let object: object | null = api;
    while (object !== null && object !== Object.prototype) { Object.getOwnPropertyNames(object).forEach((name) => names.add(name)); object = Object.getPrototypeOf(object) as object | null; }
    for (const name of names) if (/^(resolve|reverse|lookup)/u.test(name) && typeof Reflect.get(api, name) === "function") {
      mocks.push(vi.spyOn(api as unknown as Record<string, () => unknown>, name).mockImplementation(denied));
    }
  }
  syncBuiltinESMExports();
  afterAll(() => { for (const mock of mocks) mock.mockRestore(); syncBuiltinESMExports(); });
}
