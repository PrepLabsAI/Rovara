import { Socket } from "node:net";
import { afterAll, beforeAll, vi } from "vitest";

// The lane suite has no network dependency. Block before DNS/connect, including libraries that
// construct Socket directly. The real-process fixtures execute only the inline, local FS scripts.
export function allowLoopbackOnly(args: readonly unknown[]): void {
  const values: readonly unknown[] = Array.isArray(args[0]) ? args[0] as unknown[] : args;
  const first = values[0];
  const options = typeof first === "object" && first !== null ? first as { host?: unknown; path?: unknown } : undefined;
  if (typeof options?.path === "string" || typeof first === "string" && !/^[0-9]+$/u.test(first)) return; // local Unix socket
  const host = options?.host ?? (typeof values[1] === "string" ? values[1] : "localhost");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") throw new Error("mutation spot tests forbid non-loopback sockets");
}
let undo: (() => void) | undefined;
beforeAll(() => {
  // The original method is invoked below with the same socket as its explicit receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const connect = Socket.prototype.connect;
  const spy = vi.spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket, ...args: unknown[]) {
    allowLoopbackOnly(args);
    return Reflect.apply(connect, this, args) as Socket;
  });
  undo = () => spy.mockRestore();
});
afterAll(() => undo?.());
