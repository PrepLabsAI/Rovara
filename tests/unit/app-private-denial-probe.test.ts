// Browser testing, egress gate: the pinned qualification probe that the APP network is refused every private-network address.
// The probe's guard is the asset's own start command, so these tests run it for real (a Node child) with `net.connect` replaced by a stub that answers per address and records what was dialled.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SANDBOX_EGRESS_PROBE_IDS, WEB_API_REQUIRED_PROBES, WEB_API_BEFORE_PRIVATE_NETWORK_PROBE_COUNT, evaluateWebApiProbeObservation } from "../../packages/contracts/src/index.js";
import { loadWebApiQualificationProbeAssets } from "../../packages/verifier/src/application-runtime-probes.js";
import { webApiAppStartGuardArgs, webApiProbeDriver } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { goodWebApiObservation } from "../support/web-api-qualification.js";

const ID = "app-private-denial-v1";
const pin = WEB_API_REQUIRED_PROBES.find((probe) => probe.probeId === ID)!;
const loadAsset = () => loadWebApiQualificationProbeAssets().find((item) => item.probeId === ID)!;

describe("the probe is pinned into the qualification", () => {
  it("is the last required probe, an API probe that must PASS, and one of the egress probes the browser gate reads", () => {
    expect(WEB_API_REQUIRED_PROBES.at(-1)!.probeId).toBe(ID);
    // A qualification from before it holds the fourteen probes that precede it, in the same positions.
    expect(WEB_API_REQUIRED_PROBES.slice(0, WEB_API_BEFORE_PRIVATE_NETWORK_PROBE_COUNT).map((probe) => probe.probeId)).not.toContain(ID);
    expect(WEB_API_REQUIRED_PROBES).toHaveLength(WEB_API_BEFORE_PRIVATE_NETWORK_PROBE_COUNT + 1);
    expect(pin).toMatchObject({ kind: "api", expectedOutcome: "PASS", cause: null });
    expect(SANDBOX_EGRESS_PROBE_IDS).toContain(ID);
  });

  it("pins the shipped asset's bytes, and shares the API state scenario with the host probe so only the start guard differs", () => {
    const bytes = readFileSync(new URL("../../packages/verifier/assets/application-runtime-v1/probes/app-private-denial-v1.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pin.assetDigest);
    const asset = loadAsset();
    expect(asset.assetDigest).toBe(pin.assetDigest);
    const host = WEB_API_REQUIRED_PROBES.find((probe) => probe.probeId === "app-host-denial-v1")!;
    expect([pin.scenarioDigest, pin.bundleDigest]).toEqual([host.scenarioDigest, host.bundleDigest]);
    expect(pin.assetDigest).not.toBe(host.assetDigest);
    expect(webApiProbeDriver(ID)).toMatchObject({ probe: "api-state-positive-v1", startArgs: asset.probe.oracle.kind === "protected-network-denial" ? asset.probe.oracle.appStart!.args : null });
    expect([...webApiAppStartGuardArgs(ID)]).not.toEqual([...webApiAppStartGuardArgs("app-host-denial-v1")]);
  });

  it("passes only for a run in which the app started and every assertion held: the app not starting (a reachable address) is a failed positive probe", () => {
    const good = goodWebApiObservation(ID);
    expect(evaluateWebApiProbeObservation(ID, good)).toEqual({ ok: true });
    // The guard exits 3 when any attempt got through, so the app never starts and the run is unavailable.
    for (const runUnavailableReason of ["app-exited", "app-start-timeout"]) {
      expect(evaluateWebApiProbeObservation(ID, { ...good, collectorStatus: null, runUnavailableReason })).toEqual({ ok: false, reason: `positive-probe-failed:${ID}` });
    }
    expect(evaluateWebApiProbeObservation(ID, { ...good, collectorStatus: "FAILED", failedAssertionKinds: ["state"] })).toEqual({ ok: false, reason: `positive-probe-failed:${ID}` });
    expect(evaluateWebApiProbeObservation(ID, { ...good, collectorStatus: "UNKNOWN" })).toEqual({ ok: false, reason: `positive-probe-failed:${ID}` });
    expect(evaluateWebApiProbeObservation(ID, { ...good, skipped: 1 })).toEqual({ ok: false, reason: `probe-skipped:${ID}` });
  });
});

// ---- the guard itself
const dir = mkdtempSync(join(tmpdir(), "private-denial-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Read from the shipped file itself (not through the loader that refuses a changed asset), so a change to the guard fails these behaviour tests on its own and not only the digest pin above.
const guard = (() => { const args = (JSON.parse(readFileSync(new URL("../../packages/verifier/assets/application-runtime-v1/probes/app-private-denial-v1.json", import.meta.url), "utf8")) as { oracle: { appStart: { args: string[] } } }).oracle.appStart.args; return { args, script: args[2]! }; })();
writeFileSync(join(dir, "server.mjs"), `import { writeFileSync } from "node:fs"; export function startOrdersServer() { writeFileSync(${JSON.stringify(join(dir, "started"))}, "1"); }\n`);
// The stub answers per "host:port" (default: a timeout) and records every dial.
writeFileSync(join(dir, "stub.cjs"), `
const net = require("node:net"); const { EventEmitter } = require("node:events"); const fs = require("node:fs");
const answers = JSON.parse(process.env.STUB_ANSWERS || "{}");
net.connect = (options) => {
  const socket = new EventEmitter(); socket.destroy = () => {};
  const key = options.host + ":" + options.port;
  fs.appendFileSync(process.env.STUB_LOG, key + " timeout=" + options.timeout + "\\n");
  const answer = answers[key] || "timeout";
  setImmediate(() => { if (answer === "connect") socket.emit("connect"); else if (answer === "timeout") socket.emit("timeout"); else socket.emit("error", Object.assign(new Error(answer), { code: answer })); });
  return socket;
};
require("node:module").syncBuiltinESMExports();
`);

function runGuard(answers: Record<string, string>) {
  rmSync(join(dir, "started"), { force: true });
  const log = join(dir, `dials-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, "");
  const result = spawnSync(process.execPath, ["--require", join(dir, "stub.cjs"), ...guard.args], { cwd: dir, env: { PATH: process.env.PATH ?? "", STUB_ANSWERS: JSON.stringify(answers), STUB_LOG: log }, encoding: "utf8", timeout: 20_000 });
  const raw = readFileSync(log, "utf8");
  const dialled = raw.trim().split("\n").filter((line) => line !== "").map((line) => line.split(" ")[0]!);
  return { status: result.status, started: existsSync(join(dir, "started")), dialled, raw };
}
const allTargets = (() => runGuard({}).dialled)();
const ip = (address: string) => address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
const inCidr = (address: string, base: string, bits: number) => Math.floor(ip(address) / 2 ** (32 - bits)) === Math.floor(ip(base) / 2 ** (32 - bits));

describe("the guard that starts the app only when every private-network address is blocked", () => {
  it("starts the app when every attempt times out", () => {
    expect(runGuard({})).toMatchObject({ status: 0, started: true });
  });

  it("starts the app when every attempt has no route (an internal bridge has no default route)", () => {
    expect(runGuard(Object.fromEntries(allTargets.map((target) => [target, "ENETUNREACH"])))).toMatchObject({ status: 0, started: true });
    expect(runGuard(Object.fromEntries(allTargets.map((target) => [target, "EHOSTUNREACH"])))).toMatchObject({ status: 0, started: true });
  });

  it("dials the metadata and resolver addresses and an address in each private range, every one of them over a 3 second limit", () => {
    expect(allTargets.length).toBeGreaterThanOrEqual(10);
    const hosts = allTargets.map((target) => target.split(":")[0]!);
    for (const required of ["169.254.169.254", "169.254.169.253"]) expect(hosts, required).toContain(required);
    const ranges: Array<[string, string, number]> = [["10/8", "10.0.0.0", 8], ["172.16/12", "172.16.0.0", 12], ["192.168/16", "192.168.0.0", 16], ["169.254/16", "169.254.0.0", 16], ["100.64/10", "100.64.0.0", 10]];
    for (const [name, base, bits] of ranges) expect(hosts.some((host) => inCidr(host, base, bits)), name).toBe(true);
    // The VPC resolver of a 10.x and of a 172.x VPC (the base address plus 2) and the top of each range are dialled too.
    for (const required of ["10.0.0.2", "172.31.0.2", "10.255.255.254", "172.31.255.254", "192.168.255.254"]) expect(hosts, required).toContain(required);
    const lines = runGuard({}).raw.trim().split("\n");
    expect(lines.every((line) => line.endsWith(" timeout=3000"))).toBe(true);
  });

  it("refuses to start the app when ANY single address answers: one reachable target is a failed probe", () => {
    expect(allTargets.length).toBeGreaterThan(0);
    for (const target of allTargets) {
      const run = runGuard({ [target]: "connect" });
      expect(run, `${target} connects`).toMatchObject({ status: 3, started: false });
    }
  });

  it("treats a refusal or a reset as reachable: something answered, so nothing blocked it", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EACCES"]) {
      for (const target of [allTargets[0]!, allTargets.at(-1)!]) expect(runGuard({ [target]: code }), `${target} ${code}`).toMatchObject({ status: 3, started: false });
    }
  });

  it("counts every attempt: the app starts only after all of them finished, so the first blocked one cannot stand for the rest", () => {
    // Everything blocked but the very last target: the guard still refuses.
    const last = allTargets.at(-1)!;
    expect(runGuard({ [last]: "connect" })).toMatchObject({ status: 3, started: false });
    // The dial list has no duplicates and no loopback or public address in it: every one is a private-network address.
    expect(new Set(allTargets).size).toBe(allTargets.length);
    for (const target of allTargets) {
      const host = target.split(":")[0]!;
      expect([["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16], ["100.64.0.0", 10]].some(([base, bits]) => inCidr(host, base as string, bits as number)), host).toBe(true);
    }
  });
});
