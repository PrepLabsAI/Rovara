import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARD_GATEWAY, GUARD_PATHS, runGuard, substituteGuard, type GuardWorld } from "../support/agent-probe-guard.js";

// Task 4.5: the guard `web-agent-app-isolation-v1` starts the app behind. It must look for the model socket, try `model-proxy:8080` and try the gateway on 8080, and start the
// app only when every attempt fails. The pinned script is run in a child Node with the world described by each case (see tests/support/agent-probe-guard.ts); the same
// script runs for real, inside the run's network, in tests/linux/e2e-agent-probes.test.ts.
const asset = JSON.parse(readFileSync(join(import.meta.dirname, "../../packages/verifier/assets/application-runtime-v1/probes/web-agent-app-isolation-v1.json"), "utf8")) as
  { oracle: { kind: string; appStart: { program: string; args: string[] } } };
const script = asset.oracle.appStart.args[2]!;
const SINKHOLE = "172.20.0.2";
/** The run as it is when it is isolated: no socket, `model-proxy` resolving to the run's own sinkhole, a gateway that drops. */
const isolated: GuardWorld = { socket: false, proxyAddress: SINKHOLE, nameserver: SINKHOLE, gatewayRoute: true, connects: { [GUARD_GATEWAY]: "timeout" } };
const world = (change: Partial<GuardWorld>): GuardWorld => ({ ...isolated, ...change, connects: { ...isolated.connects, ...change.connects } });

describe("the app-start guard of web-agent-app-isolation-v1", () => {
  it("is a node module script in the asset, and the harness can substitute each path it reads exactly once", () => {
    expect(asset.oracle.kind).toBe("agent-app-isolation");
    expect(asset.oracle.appStart.program).toBe("node");
    expect(asset.oracle.appStart.args).toEqual(["--input-type=module", "-e", expect.any(String)]);
    expect(script.length).toBeGreaterThan(200);
    for (const literal of GUARD_PATHS) expect(script.split(literal)).toHaveLength(2);
    expect(() => substituteGuard(script, [["/not/in/the/guard", "x"]])).toThrow(/exactly once/);
  });

  it("starts the app when the socket is absent, the name leads only to the run's sinkhole and the gateway drops, having tried the name and the gateway", () => {
    const run = runGuard(script, isolated);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.started).toBe(true);
    expect(run.lookups).toEqual(["model-proxy"]);
    // The name resolves to the run's own sinkhole, which is not a model path, so only the gateway is dialed.
    expect(run.connects).toEqual([`${GUARD_GATEWAY}:8080`]);
  });

  it("does not start the app when the model socket is visible, and still tries the other two paths", () => {
    const run = runGuard(script, world({ socket: true }));
    expect(run.exitCode).toBe(3);
    expect(run.started).toBe(false);
    expect(run.lookups).toEqual(["model-proxy"]);
    expect(run.connects).toEqual([`${GUARD_GATEWAY}:8080`]);
  });

  it("does not start the app when model-proxy leads to an address that accepts a connection on 8080", () => {
    const run = runGuard(script, world({ proxyAddress: "10.0.0.9", connects: { "10.0.0.9": "connect" } }));
    expect(run.exitCode).toBe(3);
    expect(run.started).toBe(false);
    expect([...run.connects].sort()).toEqual([`${GUARD_GATEWAY}:8080`, "10.0.0.9:8080"].sort());
  });

  it("starts the app when model-proxy leads to an address that does not answer (a timeout) or refuses, and does not resolve at all", () => {
    for (const outcome of ["timeout", "error"] as const) {
      const run = runGuard(script, world({ proxyAddress: "10.0.0.9", connects: { "10.0.0.9": outcome } }));
      expect({ outcome, exitCode: run.exitCode, started: run.started }).toEqual({ outcome, exitCode: 0, started: true });
      expect(run.connects).toContain("10.0.0.9:8080");
    }
    const unresolved = runGuard(script, world({ proxyAddress: null }));
    expect(unresolved.exitCode).toBe(0);
    expect(unresolved.started).toBe(true);
    expect(unresolved.lookups).toEqual(["model-proxy"]);
  });

  it("does not start the app when the gateway on 8080 accepts a connection or refuses it (only a drop proves the wall)", () => {
    for (const outcome of ["connect", "error"] as const) {
      const run = runGuard(script, world({ connects: { [GUARD_GATEWAY]: outcome } }));
      expect({ outcome, exitCode: run.exitCode, started: run.started }).toEqual({ outcome, exitCode: 3, started: false });
      expect(run.connects).toContain(`${GUARD_GATEWAY}:8080`);
    }
  });

  it("does not start the app when it can find no gateway to try", () => {
    const run = runGuard(script, world({ gatewayRoute: false }));
    expect(run.exitCode).toBe(3);
    expect(run.started).toBe(false);
  });

  it("copes with a resolv.conf it cannot read: the name is then tried wherever it leads", () => {
    const run = runGuard(script, world({ nameserver: null, proxyAddress: "10.0.0.9", connects: { "10.0.0.9": "connect" } }));
    expect(run.exitCode).toBe(3);
    expect(run.started).toBe(false);
    const quiet = runGuard(script, world({ nameserver: null, proxyAddress: "10.0.0.9", connects: { "10.0.0.9": "timeout" } }));
    expect(quiet.started).toBe(true);
  });

  it("sends nothing to the proxy name: a bare connect, so the run's sinkhole records no call from the guard", () => {
    expect(script).not.toMatch(/\bfetch\b|\bhttp\b|\.request\(|\.write\(/);
  });
});
