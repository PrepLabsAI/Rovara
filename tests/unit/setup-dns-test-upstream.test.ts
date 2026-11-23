import { createSocket } from "node:dgram";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindDnsTestUpstream } from "../support/setup-dns-test-upstream.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); vi.restoreAllMocks(); });

let assignedPort = 10_000;
function controlledListeners(error?: Error) {
  const udp = createSocket("udp4");
  const tcp = createServer();
  const port = ++assignedPort; // An OS result simulated without binding in this policy test.
  let bound = false;
  vi.spyOn(udp, "bind").mockImplementation((...args: unknown[]) => {
    expect(args[0]).toBe(0);
    bound = true;
    queueMicrotask(args.at(-1) as () => void);
    return udp;
  });
  vi.spyOn(udp, "address").mockImplementation(() => {
    if (!bound) throw new Error("UDP socket is closed");
    return { address: "127.0.0.1", family: "IPv4", port };
  });
  vi.spyOn(udp, "close").mockImplementation((callback?: () => void) => {
    bound = false;
    callback?.();
    return udp;
  });
  vi.spyOn(tcp, "listen").mockImplementation((...args: unknown[]) => {
    expect(args[0]).toBe(port);
    queueMicrotask(() => { if (error) tcp.emit("error", error); else (args.at(-1) as () => void)(); });
    return tcp;
  });
  vi.spyOn(tcp, "close").mockImplementation((callback?: (error?: Error) => void) => {
    callback?.();
    return tcp;
  });
  return { udp, tcp };
}

describe("the fake DNS upstream's shared UDP/TCP port", () => {
  it("serves both transports on the OS-assigned port without releasing UDP", async () => {
    const bound = await bindDnsTestUpstream(() => {
      const udp = createSocket("udp4");
      udp.on("message", (message, remote) => { udp.send(message, remote.port, remote.address); });
      return { udp, tcp: createServer((socket) => socket.end("tcp")) };
    });
    closers.push(bound.close);
    expect(bound.port).toBeGreaterThan(0);
    const client = createSocket("udp4");
    try {
      const reply = once(client, "message");
      client.send(Buffer.from("udp"), bound.port, "127.0.0.1");
      expect((await reply)[0]).toEqual(Buffer.from("udp"));
    } finally { client.close(); }
    const tcp = connect(bound.port, "127.0.0.1");
    try { expect((await once(tcp, "data"))[0]).toEqual(Buffer.from("tcp")); }
    finally { tcp.destroy(); }
  });

  it("retries a TCP bind collision with fresh sockets and closes the abandoned UDP socket", async () => {
    const failed = controlledListeners(Object.assign(new Error("collision"), { code: "EADDRINUSE" }));
    let attempts = 0;
    const bound = await bindDnsTestUpstream(() => {
      attempts += 1;
      return attempts === 1 ? failed : controlledListeners();
    });
    closers.push(bound.close);
    expect(attempts).toBe(2);
    expect(() => failed.udp.address()).toThrow();
    expect(failed.tcp.listening).toBe(false);
    expect(bound.port).toBeGreaterThan(0);
  });

  it("gives up after five collisions, closes every socket, and preserves the bind error", async () => {
    const error = Object.assign(new Error("collision"), { code: "EADDRINUSE" });
    const failed: ReturnType<typeof controlledListeners>[] = [];
    let attempts = 0;
    await expect(bindDnsTestUpstream(() => {
      attempts += 1;
      // A broken retry bound must fail promptly instead of opening sockets forever.
      expect(attempts).toBeLessThanOrEqual(6);
      const pair = controlledListeners(error);
      failed.push(pair);
      return pair;
    })).rejects.toBe(error);
    expect(attempts).toBe(5);
    for (const { udp, tcp } of failed) {
      expect(() => udp.address()).toThrow();
      expect(tcp.listening).toBe(false);
    }
  });

  it("does not retry unrelated bind errors and still closes the UDP socket", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const failed = controlledListeners(error);
    let attempts = 0;
    await expect(bindDnsTestUpstream(() => {
      attempts += 1;
      expect(attempts).toBe(1);
      return failed;
    })).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(() => failed.udp.address()).toThrow();
  });
});
