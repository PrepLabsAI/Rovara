import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GUARD_GATEWAY, GUARD_MARKER, GUARD_PAGE_PATH, GUARD_PATHS, startGuard, substituteGuard, type GuardRun, type GuardWorld } from "../support/agent-probe-guard.js";

// Task 4.5 (and its fix round 1): the guard `web-agent-app-isolation-v1` starts the app behind. It looks for the model socket, tries `model-proxy:8080` and the gateway on 8080, starts the
// app only when every attempt fails, and then keeps checking for the app's whole life: on a short interval, and before it answers each request. The host starts the app before it opens
// the model channel, so the check at start proves nothing about the socket; the ones that follow do. The pinned script is run in a child Node with the world each case describes (see
// tests/support/agent-probe-guard.ts); the same script runs for real, inside the run's network, in tests/linux/e2e-agent-probes.test.ts.
const asset = JSON.parse(readFileSync(join(import.meta.dirname, "../../packages/verifier/assets/application-runtime-v1/probes/web-agent-app-isolation-v1.json"), "utf8")) as
  { oracle: { kind: string; appStart: { program: string; args: string[] } } };
const script = asset.oracle.appStart.args[2]!;
const SINKHOLE = "172.20.0.2";
/** The run as it is when it is isolated: no socket, `model-proxy` resolving to the run's own sinkhole, a gateway that drops. */
const isolated: GuardWorld = { socket: false, proxyAddress: SINKHOLE, nameserver: SINKHOLE, gatewayRoute: true, connects: { [GUARD_GATEWAY]: "timeout" } };
const world = (change: Partial<GuardWorld>): GuardWorld => ({ ...isolated, ...change, connects: { ...isolated.connects, ...change.connects } });
const running: GuardRun[] = [];
const start = async (change: Partial<GuardWorld> = {}) => { const run = await startGuard(script, world(change)); running.push(run); return run; };
afterEach(() => { for (const run of running.splice(0)) run.stop(); });

describe("the app-start guard of web-agent-app-isolation-v1", () => {
  it("is a node module script in the asset, and the harness can substitute each path it reads exactly once", () => {
    expect(asset.oracle.kind).toBe("agent-app-isolation");
    expect(asset.oracle.appStart.program).toBe("node");
    expect(asset.oracle.appStart.args).toEqual(["--input-type=module", "-e", expect.any(String)]);
    expect(script.length).toBeGreaterThan(200);
    for (const literal of GUARD_PATHS) expect(script.split(literal)).toHaveLength(2);
    expect(() => substituteGuard(script, [["/not/in/the/guard", "x"]])).toThrow(/exactly once/);
  });

  it("starts the app when the socket is absent, the name leads only to the run's sinkhole and the gateway drops, having tried the name and the gateway, and the app answers", async () => {
    const run = await start();
    expect(run.stderr()).toBe("");
    expect(run.started).toBe(true);
    expect(run.exitCode()).toBeNull();
    expect(run.lookups()).toContain("model-proxy");
    // The name resolves to the run's own sinkhole, which is not a model path, so only the gateway is dialed.
    expect(new Set(run.connects())).toEqual(new Set([`${GUARD_GATEWAY}:8080`]));
    expect(await run.get("/")).toEqual({ status: 200, body: "app /" });
  });

  it("does not start the app when the model socket is visible, and still tries the other two paths", async () => {
    const run = await start({ socket: true });
    expect(run.started).toBe(false);
    expect(await run.exited(10_000)).toBe(3);
    expect(run.lookups()).toEqual(["model-proxy"]);
    expect(run.connects()).toEqual([`${GUARD_GATEWAY}:8080`]);
  });

  it("does not start the app when model-proxy leads to an address that accepts a connection on 8080", async () => {
    const run = await start({ proxyAddress: "10.0.0.9", connects: { "10.0.0.9": "connect" } });
    expect(run.started).toBe(false);
    expect(await run.exited(10_000)).toBe(3);
    expect([...run.connects()].sort()).toEqual([`${GUARD_GATEWAY}:8080`, "10.0.0.9:8080"].sort());
  });

  it("starts the app when model-proxy leads to an address that does not answer (a timeout) or refuses, and when it does not resolve at all", async () => {
    for (const outcome of ["timeout", "error"] as const) {
      const run = await start({ proxyAddress: "10.0.0.9", connects: { "10.0.0.9": outcome } });
      expect({ outcome, started: run.started, exitCode: run.exitCode() }).toEqual({ outcome, started: true, exitCode: null });
      expect(run.connects()).toContain("10.0.0.9:8080");
    }
    const unresolved = await start({ proxyAddress: null });
    expect(unresolved.started).toBe(true);
    expect(unresolved.lookups()).toContain("model-proxy");
  });

  it("does not start the app when the gateway on 8080 accepts a connection or refuses it (only a drop proves the wall)", async () => {
    for (const outcome of ["connect", "error"] as const) {
      const run = await start({ connects: { [GUARD_GATEWAY]: outcome } });
      expect({ outcome, started: run.started, exitCode: await run.exited(10_000) }).toEqual({ outcome, started: false, exitCode: 3 });
      expect(run.connects()).toContain(`${GUARD_GATEWAY}:8080`);
    }
  });

  it("does not start the app when it can find no gateway to try", async () => {
    const run = await start({ gatewayRoute: false });
    expect(run.started).toBe(false);
    expect(await run.exited(10_000)).toBe(3);
  });

  it("copes with a resolv.conf it cannot read: the name is then tried wherever it leads", async () => {
    const refused = await start({ nameserver: null, proxyAddress: "10.0.0.9", connects: { "10.0.0.9": "connect" } });
    expect(refused.started).toBe(false);
    expect(await refused.exited(10_000)).toBe(3);
    expect((await start({ nameserver: null, proxyAddress: "10.0.0.9", connects: { "10.0.0.9": "timeout" } })).started).toBe(true);
  });

  it("sends nothing to the proxy name: a bare connect, so the run's sinkhole records no call from the guard", () => {
    expect(script).not.toMatch(/\bfetch\b|\bhttp\b|\.request\(|\.write\(/);
  });

  describe("after the app has started (the host opens the model channel after it starts the app)", () => {
    it("ends the app when the model socket appears later (a late mount), within a moment", async () => {
      const run = await start();
      expect(run.started).toBe(true);
      expect(await run.exited(1_000)).toBeNull();
      run.mountSocket();
      expect(await run.exited(5_000)).toBe(3);
    });

    it("ends the app when the gateway starts to answer later, or the proxy name starts to lead somewhere that accepts, found by the loop that repeats the full check", async () => {
      const gateway = await start({ intervalOff: true });
      expect(await gateway.exited(800)).toBeNull();
      gateway.setWorld({ connects: { [GUARD_GATEWAY]: "connect" } });
      expect(await gateway.exited(8_000)).toBe(3);
      const proxy = await start({ intervalOff: true });
      expect(await proxy.exited(800)).toBeNull();
      proxy.setWorld({ proxyAddress: "10.0.0.9", connects: { "10.0.0.9": "connect" } });
      expect(await proxy.exited(8_000)).toBe(3);
    });

    it("ends the app on the socket within a moment by the fast interval alone, with the loop that repeats the full check switched off", async () => {
      const run = await start({ loopOff: true });
      expect(await run.exited(800)).toBeNull();
      run.mountSocket();
      expect(await run.exited(3_000)).toBe(3);
    });

    it("checks before it answers a request: a socket visible then answers 500 and ends the app, and an app that answered before is not asked again", async () => {
      const run = await start();
      expect((await run.get("/")).status).toBe(200);
      run.mountSocket();
      const late = await run.get("/orders").then((reply) => reply.status, () => "closed");
      // Either the interval ended the app first (the connection is closed) or the request check answered 500; never the app's own 200.
      expect(late === "closed" || late === 500).toBe(true);
      expect(await run.exited(5_000)).toBe(3);
    });

    it("also checks before it answers a request, with the checks that repeat switched off: a socket mounted since the start answers 500 to the very first request and ends the app, never the app's 200", async () => {
      const run = await start({ intervalOff: true, loopOff: true });
      run.mountSocket();
      expect(await run.exited(1_000)).toBeNull();
      expect((await run.get("/")).status).toBe(500);
      expect(await run.exited(5_000)).toBe(3);
    });

    it("also checks the gateway and the proxy name before it answers a request, with the checks that repeat switched off", async () => {
      const gateway = await start({ intervalOff: true, loopOff: true });
      gateway.setWorld({ connects: { [GUARD_GATEWAY]: "connect" } });
      expect((await gateway.get("/")).status).toBe(500);
      expect(await gateway.exited(5_000)).toBe(3);
      const proxy = await start({ intervalOff: true, loopOff: true });
      proxy.setWorld({ proxyAddress: "10.0.0.9", connects: { "10.0.0.9": "connect" } });
      expect((await proxy.get("/")).status).toBe(500);
      expect(await proxy.exited(5_000)).toBe(3);
    });

    it("serves its own page, with the marker only once an earlier request was checked before it was answered", async () => {
      const run = await start();
      const first = await run.get(GUARD_PAGE_PATH);
      expect(first.status).toBe(200);
      expect(first.body).not.toContain(GUARD_MARKER);
      expect((await run.get("/")).body).toBe("app /");
      const second = await run.get(GUARD_PAGE_PATH);
      expect(second.body).toContain(GUARD_MARKER);
      // The page is the guard's, not the app's: the app never saw the request.
      expect(second.body).not.toContain("app ");
    });
  });
});
