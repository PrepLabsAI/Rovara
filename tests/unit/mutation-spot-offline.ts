import { Socket } from "node:net";
import { afterEach, beforeEach, vi } from "vitest";

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
/**
 * Install the loopback-only guard around EACH test of the calling file. Call it at the top level of every mutation-spot test file.
 * Not a module side effect: under a shared module graph (Vitest isolate: false, the Linux and worker projects since 8f1be0a80) this
 * module loads once per worker, so a guard registered at load time only covered the FIRST file that imported it; later files ran
 * unguarded (CI test (6/8): "refuses a non-loopback socket before any connection" saw no guard).
 */
export function useLoopbackOnlyGuard(): void {
  let undo: (() => void) | undefined;
  beforeEach(() => {
    // The original method is invoked below with the same socket as its explicit receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const connect = Socket.prototype.connect;
    const spy = vi.spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket, ...args: unknown[]) {
      allowLoopbackOnly(args);
      return Reflect.apply(connect, this, args) as Socket;
    });
    undo = () => spy.mockRestore();
  });
  afterEach(() => { undo?.(); undo = undefined; });
}
