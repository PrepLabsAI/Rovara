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
import { deriveWebApiProbeObservation, verifyWebApiProbeRecord } from "../../packages/verifier/src/web-api-probe-evidence.js";
import { hostNameServers, webApiLiveTargets } from "../../packages/verifier/src/host/web-api-live-targets.js";
import { WEB_API_FIXTURE_NOW, fixtureEvidence, goodWebApiObservation, webApiChallenge } from "../support/web-api-qualification.js";

const ID = "app-private-denial-v1";
const pin = WEB_API_REQUIRED_PROBES.find((probe) => probe.probeId === ID)!;
const loadAsset = () => loadWebApiQualificationProbeAssets().find((item) => item.probeId === ID)!;

describe("the probe is pinned into the qualification", () => {
  it("is the last required probe, an API probe that must PASS, and one of the egress probes the browser gate reads", () => {
    expect(WEB_API_REQUIRED_PROBES.at(-1)!.probeId).toBe(ID);
    // A qualification from before it holds the fourteen probes that precede it, in the same positions.
    expect(WEB_API_REQUIRED_PROBES.slice(0, WEB_API_BEFORE_PRIVATE_NETWORK_PROBE_COUNT).map((probe) => probe.probeId)).not.toContain(ID);
    expect(WEB_API_REQUIRED_PROBES).toHaveLength(WEB_API_BEFORE_PRIVATE_NETWORK_PROBE_COUNT + 1);
    expect(pin).toMatchObject({ kind: "api", expectedOutcome: "PASS", cause: null, liveTargets: true });
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

describe("the probe is held to its live targets", () => {
  const challenge = webApiChallenge(WEB_API_FIXTURE_NOW);
  const derive = (probeId: string, evidence: unknown) => deriveWebApiProbeObservation({ challenge, probeId, evidence });
  const evidenceOf = (probeId: string) => structuredClone(fixtureEvidence(probeId)) as Record<string, unknown>;

  it("records the live targets the guard was handed in the evidence and in the observation, and the oracle requires them", () => {
    const good = goodWebApiObservation(ID);
    expect(good.liveTargets).toEqual({ resolver: "10.42.0.2", host: "10.42.1.15" });
    expect(evaluateWebApiProbeObservation(ID, good)).toEqual({ ok: true });
    const { liveTargets: _gone, ...without } = good;
    void _gone;
    expect(evaluateWebApiProbeObservation(ID, without)).toEqual({ ok: false, reason: `probe-live-targets-missing:${ID}` });
    // A run whose app never started is still a failed positive probe, not a "missing targets" one.
    expect(evaluateWebApiProbeObservation(ID, { ...without, collectorStatus: null, runUnavailableReason: "app-exited" })).toEqual({ ok: false, reason: `positive-probe-failed:${ID}` });
  });

  it("derives no observation from evidence that lacks them, that carries a target that is not a private IPv4 address, or that another probe carries", () => {
    expect(derive(ID, fixtureEvidence(ID))).toMatchObject({ ok: true });
    const lacking = evidenceOf(ID); delete lacking["liveTargets"];
    expect(derive(ID, lacking)).toEqual({ ok: false, reason: `probe-evidence-mismatch:${ID}` });
    for (const bad of [{ resolver: "8.8.8.8", host: "10.42.1.15" }, { resolver: "10.42.0.2", host: "169.254.169.254" }, { resolver: "10.42.0.2" }, { resolver: "10.42.0.2", host: "127.0.0.1" }]) {
      expect(derive(ID, { ...evidenceOf(ID), liveTargets: bad }), JSON.stringify(bad)).toEqual({ ok: false, reason: `probe-evidence-mismatch:${ID}` });
    }
    expect(derive("app-host-denial-v1", { ...evidenceOf("app-host-denial-v1"), liveTargets: { resolver: "10.42.0.2", host: "10.42.1.15" } })).toEqual({ ok: false, reason: "probe-evidence-mismatch:app-host-denial-v1" });
    expect(evaluateWebApiProbeObservation("app-host-denial-v1", { ...goodWebApiObservation("app-host-denial-v1"), liveTargets: { resolver: "10.42.0.2", host: "10.42.1.15" } })).toEqual({ ok: false, reason: "probe-live-targets-unexpected:app-host-denial-v1" });
  });

  it("a runtime-reader's qualified record from a run that was not handed them does not parse: the registrar re-derives the observation from the evidence", () => {
    const lacking = evidenceOf(ID); delete lacking["liveTargets"];
    expect(verifyWebApiProbeRecord({ challenge, probeId: ID, observation: goodWebApiObservation(ID), evidence: lacking })).toEqual({ ok: false, reason: `probe-evidence-mismatch:${ID}` });
    expect(verifyWebApiProbeRecord({ challenge, probeId: ID, observation: goodWebApiObservation(ID), evidence: fixtureEvidence(ID) })).toEqual({ ok: true });
    // The record claims other targets than the evidence holds.
    expect(verifyWebApiProbeRecord({ challenge, probeId: ID, observation: { ...goodWebApiObservation(ID), liveTargets: { resolver: "10.9.9.9", host: "10.42.1.15" } }, evidence: fixtureEvidence(ID) })).toEqual({ ok: false, reason: `probe-evidence-mismatch:${ID}` });
  });
});

describe("the live targets are read on the runner", () => {
  it("takes the first private IPv4 name server of the resolver files and the host of the challenge endpoint", () => {
    const files: Record<string, string> = { "/etc/resolv.conf": "nameserver 127.0.0.53\nnameserver 169.254.169.253\nnameserver 8.8.8.8\n", "/run/systemd/resolve/resolv.conf": "nameserver 10.42.0.2\nnameserver 10.42.0.3\n" };
    const read = (path: string) => { const text = files[path]; if (text === undefined) throw new Error("missing"); return text; };
    expect(hostNameServers(read)).toEqual(["127.0.0.53", "169.254.169.253", "8.8.8.8", "10.42.0.2", "10.42.0.3"]);
    expect(webApiLiveTargets({ endpoint: "http://10.42.1.15:8080", nameServers: () => hostNameServers(read) })).toEqual({ resolver: "10.42.0.2", host: "10.42.1.15" });
  });

  it("gives nothing, so the probe does not run, when there is no private name server, or the endpoint is not a private IPv4 address", () => {
    expect(webApiLiveTargets({ endpoint: "http://10.42.1.15:8080", nameServers: () => ["127.0.0.53", "8.8.8.8", "169.254.169.253"] })).toBeUndefined();
    expect(webApiLiveTargets({ endpoint: "http://10.42.1.15:8080", nameServers: () => [] })).toBeUndefined();
    for (const endpoint of ["http://203.0.113.9:8080", "http://localhost:8080", "http://169.254.169.254:8080", "not a url"]) expect(webApiLiveTargets({ endpoint, nameServers: () => ["10.42.0.2"] }), endpoint).toBeUndefined();
    expect(webApiLiveTargets({ endpoint: "http://10.42.1.15:8080", nameServers: () => { throw new Error("unreadable"); } })).toBeUndefined();
  });
});

// ---- the guard itself
const dir = mkdtempSync(join(tmpdir(), "private-denial-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Read from the shipped file itself (not through the loader that refuses a changed asset), so a change to the guard fails these behaviour tests on its own and not only the digest pin above.
const guard = (() => { const args = (JSON.parse(readFileSync(new URL("../../packages/verifier/assets/application-runtime-v1/probes/app-private-denial-v1.json", import.meta.url), "utf8")) as { oracle: { appStart: { args: string[] } } }).oracle.appStart.args; return { args, script: args[2]! }; })();
writeFileSync(join(dir, "server.mjs"), `import { writeFileSync } from "node:fs"; export function startOrdersServer() { writeFileSync(${JSON.stringify(join(dir, "started"))}, "1"); }\n`);
// The stub answers per "host:port" for TCP and per "udp:host:port" for UDP (default: a timeout, and for UDP no answer) and records every dial. Timers are shortened so a silent UDP attempt does not take 3 seconds.
writeFileSync(join(dir, "stub.cjs"), `
const net = require("node:net"); const dgram = require("node:dgram"); const { EventEmitter } = require("node:events"); const fs = require("node:fs");
const answers = JSON.parse(process.env.STUB_ANSWERS || "{}");
const realSetTimeout = global.setTimeout; global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms, 40), ...rest);
const fail = (socket, code) => socket.emit("error", Object.assign(new Error(code), { code }));
net.connect = (options) => {
  const socket = new EventEmitter(); socket.destroy = () => {};
  fs.appendFileSync(process.env.STUB_LOG, options.host + ":" + options.port + " timeout=" + options.timeout + "\\n");
  const answer = answers[options.host + ":" + options.port] || "timeout";
  setImmediate(() => { if (answer === "connect") socket.emit("connect"); else if (answer === "timeout") socket.emit("timeout"); else fail(socket, answer); });
  return socket;
};
dgram.createSocket = () => {
  const socket = new EventEmitter(); socket.close = () => {};
  socket.send = (message, port, host, callback) => {
    fs.appendFileSync(process.env.STUB_LOG, "udp:" + host + ":" + port + " bytes=" + message.length + "\\n");
    const answer = answers["udp:" + host + ":" + port] || "silent";
    setImmediate(() => { if (answer === "message") socket.emit("message", Buffer.alloc(12)); else if (answer !== "silent") callback(Object.assign(new Error(answer), { code: answer })); });
  };
  return socket;
};
require("node:module").syncBuiltinESMExports();
`);

const LIVE = { ROVARA_PROBE_LIVE_RESOLVER: "10.42.0.2", ROVARA_PROBE_LIVE_HOST: "10.42.1.15" };
function runGuard(answers: Record<string, string>, env: Record<string, string> = LIVE) {
  rmSync(join(dir, "started"), { force: true });
  const log = join(dir, `dials-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, "");
  const result = spawnSync(process.execPath, ["--require", join(dir, "stub.cjs"), ...guard.args], { cwd: dir, env: { PATH: process.env.PATH ?? "", STUB_ANSWERS: JSON.stringify(answers), STUB_LOG: log, ...env }, encoding: "utf8", timeout: 20_000 });
  const raw = readFileSync(log, "utf8");
  const dialled = raw.trim().split("\n").filter((line) => line !== "").map((line) => line.split(" ")[0]!);
  return { status: result.status, started: existsSync(join(dir, "started")), dialled, raw };
}
const allTargets = (() => runGuard({}).dialled)();
const tcpTargets = allTargets.filter((target) => !target.startsWith("udp:"));
const ip = (address: string) => address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
const inCidr = (address: string, base: string, bits: number) => Math.floor(ip(address) / 2 ** (32 - bits)) === Math.floor(ip(base) / 2 ** (32 - bits));
const refused = { status: 3, started: false };
const answeredBy = (target: string, code: string) => ({ [target]: target.startsWith("udp:") ? "message" : code });

describe("the guard that starts the app only when every private-network address is blocked", () => {
  it("starts the app when every attempt times out or gets no answer", () => {
    expect(runGuard({})).toMatchObject({ status: 0, started: true });
  });

  it("starts the app when every attempt has no route (an internal bridge has no default route), and when the IPv6 address has nowhere to go", () => {
    for (const code of ["ENETUNREACH", "EHOSTUNREACH"]) {
      expect(runGuard(Object.fromEntries(allTargets.map((target) => [target, target.startsWith("udp:") ? code : code]))), code).toMatchObject({ status: 0, started: true });
    }
    for (const code of ["EADDRNOTAVAIL", "EAFNOSUPPORT"]) expect(runGuard({ "fd00:ec2::254:80": code, ...Object.fromEntries(allTargets.filter((target) => target.startsWith("fd00")).map((target) => [target, code])) }), code).toMatchObject({ status: 0, started: true });
  });

  it("dials the metadata and Amazon DNS addresses, an address in each private range, and the IPv6 metadata address, every TCP attempt over a 3 second limit", () => {
    const hosts = tcpTargets.map((target) => target.slice(0, target.lastIndexOf(":")));
    for (const required of ["169.254.169.254", "169.254.169.253", "fd00:ec2::254"]) expect(hosts, required).toContain(required);
    const v4 = hosts.filter((host) => !host.includes(":"));
    const ranges: Array<[string, string, number]> = [["10/8", "10.0.0.0", 8], ["172.16/12", "172.16.0.0", 12], ["192.168/16", "192.168.0.0", 16], ["169.254/16", "169.254.0.0", 16], ["100.64/10", "100.64.0.0", 10]];
    for (const [name, base, bits] of ranges) expect(v4.some((host) => inCidr(host, base, bits)), name).toBe(true);
    for (const required of ["10.255.255.254", "172.31.255.254", "192.168.255.254", "100.64.0.1"]) expect(v4, required).toContain(required);
    expect(runGuard({}).raw.trim().split("\n").filter((line) => !line.startsWith("udp:")).every((line) => line.endsWith(" timeout=3000"))).toBe(true);
  });

  it("dials the LIVE targets it is handed, and only the ones it is handed: the resolver on TCP and UDP 53, the host on two TCP ports", () => {
    expect(allTargets).toEqual(expect.arrayContaining(["10.42.0.2:53", "udp:10.42.0.2:53", "10.42.1.15:80", "10.42.1.15:8080"]));
    const other = runGuard({}, { ROVARA_PROBE_LIVE_RESOLVER: "172.20.0.2", ROVARA_PROBE_LIVE_HOST: "192.168.9.9" });
    expect(other).toMatchObject({ status: 0, started: true });
    expect(other.dialled).toEqual(expect.arrayContaining(["172.20.0.2:53", "udp:172.20.0.2:53", "192.168.9.9:80", "192.168.9.9:8080"]));
    expect(other.dialled.join(" ")).not.toContain("10.42.");
  });

  it("refuses to start the app when a live target is missing or is not a private IPv4 address: a host that forgets them cannot make the probe weaker", () => {
    const bad = ["", "1.1.1.1", "8.8.8.8", "127.0.0.1", "169.254.169.253", "0.0.0.0", "10.42.0.2:53", "10.42.0", "172.32.0.1", "172.15.0.1", "100.128.0.1", "100.63.0.1", "192.169.0.1", "fd00::1", "10.42.0.2 ", "localhost"];
    for (const value of bad) {
      expect(runGuard({}, { ROVARA_PROBE_LIVE_RESOLVER: value, ROVARA_PROBE_LIVE_HOST: "10.42.1.15" }), `resolver ${JSON.stringify(value)}`).toMatchObject(refused);
      expect(runGuard({}, { ROVARA_PROBE_LIVE_RESOLVER: "10.42.0.2", ROVARA_PROBE_LIVE_HOST: value }), `host ${JSON.stringify(value)}`).toMatchObject(refused);
    }
    expect(runGuard({}, {})).toMatchObject(refused);
    expect(runGuard({}, { ROVARA_PROBE_LIVE_HOST: "10.42.1.15" })).toMatchObject(refused);
    expect(runGuard({}, { ROVARA_PROBE_LIVE_RESOLVER: "10.42.0.2" })).toMatchObject(refused);
    // Refused before anything is dialled.
    expect(runGuard({}, {}).dialled).toEqual([]);
  });

  it("refuses to start the app when ANY single target answers: one reachable target is a failed probe", () => {
    expect(allTargets.length).toBeGreaterThan(10);
    for (const target of allTargets) expect(runGuard(answeredBy(target, "connect")), `${target} answers`).toMatchObject(refused);
  });

  it("treats a refusal or a reset from a live target as reachable: with the wall missing the host's address answers with a reset", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EACCES"]) {
      for (const target of ["10.42.0.2:53", "10.42.1.15:80", "10.42.1.15:8080", "169.254.169.254:80", "10.255.255.254:80"]) expect(runGuard({ [target]: code }), `${target} ${code}`).toMatchObject(refused);
    }
  });

  it("treats a DNS answer over UDP from the live resolver as reachable, and silence, no route and a send error from a wall as blocked", () => {
    expect(runGuard({ "udp:10.42.0.2:53": "message" })).toMatchObject(refused);
    expect(runGuard({ "udp:10.42.0.2:53": "silent" })).toMatchObject({ status: 0, started: true });
    for (const code of ["ENETUNREACH", "EHOSTUNREACH"]) expect(runGuard({ "udp:10.42.0.2:53": code }), code).toMatchObject({ status: 0, started: true });
    expect(runGuard({ "udp:10.42.0.2:53": "ECONNREFUSED" })).toMatchObject(refused);
    // The query is a real DNS question (one question, type A), not an empty packet.
    expect(runGuard({}).raw).toMatch(/udp:10\.42\.0\.2:53 bytes=19/u);
  });

  it("counts every attempt: the app starts only after all of them finished, so the first blocked one cannot stand for the rest", () => {
    const last = allTargets.at(-1)!;
    expect(runGuard(answeredBy(last, "connect"))).toMatchObject(refused);
    expect(new Set(allTargets).size).toBe(allTargets.length);
    // Every IPv4 target is a private-network or link-local address; none is a public one.
    for (const target of tcpTargets.filter((item) => !item.startsWith("fd00"))) {
      const host = target.slice(0, target.lastIndexOf(":"));
      expect([["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16], ["100.64.0.0", 10]].some(([base, bits]) => inCidr(host, base as string, bits as number)), host).toBe(true);
    }
  });
});
