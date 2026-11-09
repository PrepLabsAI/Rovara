// The fake server (test services TS23, design test-services.md 4.4 and 7.5): ONE helper that replays a FixtureSet v2, and in its other mode is the record-only sinkhole. It is the merge of the two older
// mock systems:
//   System A (`server.ts`):                  replay by request hash, unmatched `fail` / `schema_synth`, named faults armed through a token-protected control path, usage counts, task additions;
//   System B (`executor/mock-server.ts`):    the hardened sockets and the request ledger (written before the answer, trusted only if the helper was still running, every caller's address kept),
//                                            both now in the shared core (`fake-core.ts`).
// Rules, all fail closed:
//   - the server listens on the RUN ADDRESS and nowhere else: a wildcard address, a host name or anything that is not a plain address is refused, and the address the kernel gave is checked after listening;
//   - it serves only a set that parses and hashes to the digest the approved environment pinned; a set it cannot place is not served;
//   - it never forwards anything. The sinkhole records what is asked of it (method, path, host, caller) and answers 599; a replay server answers from the set or fails the call. Neither makes an outbound
//     connection (the core imports nothing that could);
//   - a request body over 64 KiB, a request head over 16 KiB, and a connection past the cap are refused and counted;
//   - a response keeps only headers from the contract's allow-list (no redirect, cookie or credential header can be sent), whatever a stored entry holds;
//   - with a caller list, only calls from those addresses are answered from the set and counted as matched; any other caller gets the same 599 as the sinkhole gives, uses up no fault and is counted apart;
//   - the control paths (`/__rovara/...`) need the run's control token, which the app is never given.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FIXTURE_RESPONSE_HEADER_NAMES,
  FixtureEntrySchema,
  FixtureSetSchema,
  SERVICE_MOCK_BODY_MAX_BYTES,
  SERVICE_MOCK_NO_RECORDING_MESSAGE,
  SERVICE_MOCK_UNMATCHED_STATUS,
  canonicalJson,
  e2eApiMockFixtureToFixtureSet,
  fixtureRequestHash,
  fixtureSetDigest,
  type E2EApiMockFixture,
  type FixtureEntry,
  type FixtureSet,
  type ServiceMockFault,
  type ServiceMockUsage,
} from "@agentx/contracts";
import { createSyntheticGenerator } from "../data-guard.js";
import { callerAddress, clip, readBoundedBody, startCore, type CoreAnswer, type CoreRefusal, type CoreRequest, type CoreStrategy, type RunningCore } from "./fake-core.js";
import { FixtureSetRefused, sagemakerEndpointOfPath } from "./fixture-set.js";
import { schemaAccepts, synthesizeFromSchema } from "./schema.js";

/** The fixed answer to a call nothing matched in a sinkhole, or from a caller that is not the run's: as the E2E checker's sinkhole has always answered. */
export const FAKE_UNMOCKED_STATUS = 599;
export const FAKE_UNMOCKED_BODY = '{"error":"rovara-unmocked"}';
export const FAKE_CONTROL_PREFIX = "/__rovara/";
/** The most distinct host names a sinkhole counts one by one; later ones are counted together. */
export const FAKE_HOSTS_MAX = 64;

export class FakeServerRefused extends Error {
  constructor(readonly reason: "bind_address" | "callers_invalid" | "additions_invalid") {
    super(`fake server refused: ${reason}`);
    this.name = "FakeServerRefused";
  }
}

/** The run address: one plain IPv4 or IPv6 address that is not the unspecified (wildcard) address. A host name is not accepted, because it can resolve to several addresses. */
export function assertRunAddress(address: string): void {
  if (isIP(address) === 0) throw new FakeServerRefused("bind_address");
  let hostname: string;
  try { hostname = new URL(isIP(address) === 6 ? `http://[${address}]/` : `http://${address}/`).hostname; } catch { throw new FakeServerRefused("bind_address"); }
  const wildcard = hostname === "0.0.0.0" || hostname === "[::]" || hostname === "[::ffff:0:0]" || hostname === "[::ffff:0.0.0.0]";
  if (wildcard) throw new FakeServerRefused("bind_address");
}

type Common = {
  /** The run address the server listens on: nothing else. */
  bindAddress: string;
  port?: number;
  /** More ports the same server listens on (a sinkhole answers on 80 and 443 too, since a name that resolves to it may be asked on either). */
  additionalPorts?: readonly number[];
  /** Whose calls count: the run's sandbox addresses, or `"any"` (a test on loopback). There is no default, so a caller list is never forgotten. */
  callers: readonly string[] | "any";
  /** The ledger file; null keeps none (the bound on lines still applies). */
  ledgerPath: string | null;
  maxLines?: number;
  maxConnections?: number;
  connectionGraceMs?: number;
  connectionCeilingMs?: number;
  now?: () => Date;
  onFatal?: (error: unknown) => void;
};
export type FakeReplayOptions = Common & {
  mode: "replay";
  /** The fixture set as stored: untrusted until it has parsed and hashed to `expectedDigest` (the approved environment's `fixtureSetRef`). */
  fixtureSet: unknown;
  expectedDigest: string;
  unmatched: "fail" | "schema_synth";
  /** The task's new answers (design 7.3), already checked by the broker's pin. They are served only when the pinned set has no recording; each must be an entry of this set's own hash. */
  additionEntries?: readonly FixtureEntry[];
  /** Wait for the recorded latency before answering (off by default: a fake should be quick). */
  replayLatency?: boolean;
  controlToken?: string;
};
export type FakeSinkholeOptions = Common & { mode: "sinkhole"; label?: string };
export type FakeServerOptions = FakeReplayOptions | FakeSinkholeOptions;

/** What the fake reports: the contract's usage plus what a fake needs to say about itself. */
export type FakeUsage = ServiceMockUsage & {
  additionsServed: number;
  /** Calls from an address that is not the run's: answered 599, never matched. */
  foreignCalls: number;
  /** Calls the fake refused or could not place (TLS, a malformed head, a connection past the cap) are in `unmatchedFailed`; these are the hosts a sinkhole was asked for, most asked first. */
  hosts: { host: string; count: number }[];
};

export interface RunningFakeServer {
  /** `http://<run address>:<port>` of the first port. */
  url: string;
  ports: readonly number[];
  /** The token the control paths need; given to the scenario runner, never to the app. Empty for a sinkhole, which has no control paths. */
  controlToken: string;
  usage(): FakeUsage;
  close(): Promise<void>;
}

/** The entry fields a ledger line carries beyond the core's (`requestId`, `method`, `path`, `status`, `observedAt`, `remoteAddress`). */
export const FAKE_LEDGER_OUTCOMES = ["matched", "addition", "synthesized", "unmatched", "fault", "foreign-caller", "sinkhole", "overflow", "unplaced", "too-large", "refused", "unparsed", "dropped"] as const;
export type FakeLedgerOutcome = (typeof FAKE_LEDGER_OUTCOMES)[number];

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** What a line's `responseSha256` covers; the reader recomputes it from the stored entry. */
export const fakeResponseDigest = (response: { status: number; contentType: string; body: string }): string => sha(canonicalJson({ status: response.status, contentType: response.contentType, body: response.body }));
const UNMOCKED_DIGEST = fakeResponseDigest({ status: FAKE_UNMOCKED_STATUS, contentType: "application/json", body: FAKE_UNMOCKED_BODY });
const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const ALLOWED_HEADERS: ReadonlySet<string> = new Set(FIXTURE_RESPONSE_HEADER_NAMES);

/** The response headers of a stored entry that may be sent: the contract's allow-list only, one plain line each. A header that is not on it, or holds a control character, is dropped. */
export function allowedResponseHeaders(headers: ReadonlyArray<{ name: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (ALLOWED_HEADERS.has(name) && NO_HIDDEN.test(header.value) && header.value.length <= 256 && out[name] === undefined) out[name] = header.value;
  }
  return out;
}

/** A set that parses (which also checks every entry's own hash) and hashes to the digest the approved environment pinned; anything else is refused. */
export function loadFixtureSetV2(raw: unknown, expectedDigest: string): FixtureSet {
  const parsed = FixtureSetSchema.safeParse(raw);
  if (!parsed.success) throw new FixtureSetRefused("unreadable");
  if (fixtureSetDigest(parsed.data) !== expectedDigest) throw new FixtureSetRefused("digest_mismatch");
  return parsed.data;
}

function queryPairs(rawQuery: string): { name: string; value: string }[] {
  if (rawQuery === "") return [];
  return [...new URLSearchParams(rawQuery)].map(([name, value]) => ({ name, value }));
}

/** The host a call was for: the `Host` header, or the authority of an absolute-form target. Plain text, bounded, never trusted. */
function hostOf(request: { headers: CoreRequest["headers"]; rawUrl: string }): string | null {
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/([^/?#]{1,253})/u.exec(request.rawUrl);
  const header = request.headers.host;
  const value = absolute?.[1] ?? (typeof header === "string" ? header : null);
  return value === null ? null : clip(value.replace(/[^\x21-\x7e]/gu, "?"), 253);
}

export async function startFakeServer(options: FakeServerOptions): Promise<RunningFakeServer> {
  assertRunAddress(options.bindAddress);
  const callers = options.callers === "any" ? "any" : new Set(options.callers.map((caller) => callerAddress(caller)));
  if (callers !== "any" && (callers.size === 0 || [...callers].some((caller) => isIP(caller) === 0))) throw new FakeServerRefused("callers_invalid");

  const counts = { matched: 0, unmatchedFailed: 0, synthesized: 0, additionsServed: 0, foreignCalls: 0 };
  const hostCounts = new Map<string, number>();
  let otherHosts = 0;
  const countHost = (host: string | null): void => {
    if (host === null) return;
    if (hostCounts.has(host) || hostCounts.size < FAKE_HOSTS_MAX) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1); else otherHosts += 1;
  };
  const isForeign = (remote: string | undefined): boolean => callers !== "any" && !callers.has(callerAddress(remote));
  const unmocked = (outcome: FakeLedgerOutcome, request: { method: string; rawPath: string; host: string | null }, requestSha256?: string): CoreAnswer => ({
    status: FAKE_UNMOCKED_STATUS, contentType: "application/json", text: FAKE_UNMOCKED_BODY, headers: { connection: "close" },
    ledger: { outcome, host: request.host, entryHash: null, fault: null, requestSha256: requestSha256 ?? sha(canonicalJson({ method: clip(request.method, 16), path: clip(request.rawPath, 512), host: request.host })), responseSha256: UNMOCKED_DIGEST },
  });
  const usageOf = (service: string, faultsInjected: ServiceMockUsage["faultsInjected"]): FakeUsage => ({
    service, matched: counts.matched, unmatchedFailed: counts.unmatchedFailed, synthesized: counts.synthesized, faultsInjected,
    additionsServed: counts.additionsServed, foreignCalls: counts.foreignCalls,
    hosts: [...hostCounts].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)).concat(otherHosts > 0 ? [{ host: "(other hosts)", count: otherHosts }] : []),
  });

  let strategy: CoreStrategy;
  let usage: () => FakeUsage;
  let controlToken = "";

  if (options.mode === "sinkhole") {
    const label = options.label ?? "sinkhole";
    usage = () => usageOf(label, []);
    strategy = {
      maxBodyBytes: 0,
      decide(request, context) {
        const host = hostOf(request);
        // A sinkhole answers every call the same way and keeps only who asked for what. Nothing is read from the body and nothing is sent anywhere.
        counts.unmatchedFailed += 1;
        if (!context.full) { countHost(host); if (isForeign(request.remote)) counts.foreignCalls += 1; }
        return unmocked(context.full ? "overflow" : "sinkhole", { method: request.method, rawPath: request.rawPath, host });
      },
      refuse(call: CoreRefusal) {
        counts.unmatchedFailed += 1;
        return unmocked(call.kind === "refused" ? "refused" : call.kind === "dropped" ? "dropped" : call.kind === "body-too-large" ? "too-large" : "unparsed", { method: call.method, rawPath: call.rawPath, host: null });
      },
    };
  } else {
    const set = loadFixtureSetV2(options.fixtureSet, options.expectedDigest);
    const entries = new Map<string, FixtureEntry>(set.entries.map((entry) => [entry.requestHash, entry]));
    const additions = new Map<string, FixtureEntry>();
    for (const raw of options.additionEntries ?? []) {
      const parsed = FixtureEntrySchema.safeParse(raw);
      // An addition is held to the same rule as any entry: it is filed under the hash of its own request, so it can be served for that request and no other.
      if (!parsed.success || parsed.data.requestHash !== fixtureRequestHash(set, parsed.data.request)) throw new FakeServerRefused("additions_invalid");
      if (!entries.has(parsed.data.requestHash)) additions.set(parsed.data.requestHash, parsed.data);
    }
    controlToken = options.controlToken ?? randomBytes(24).toString("hex");
    const armed = new Map<string, number>();
    const faultsInjected = new Map<string, number>();
    const faultByName = new Map<string, ServiceMockFault>(set.faults.map((fault) => [fault.name, fault]));
    const errorTypeHeader = set.dependency.protocol === "model_invoke" || set.dependency.protocol === "aws_json";
    usage = () => usageOf(set.dependency.id, [...faultsInjected].map(([name, count]) => ({ name, count })));

    const authorised = (request: IncomingMessage): boolean => {
      const given = Buffer.from(String(request.headers["x-rovara-control"] ?? ""));
      const wanted = Buffer.from(controlToken);
      return given.length === wanted.length && timingSafeEqual(given, wanted);
    };
    const text = (response: ServerResponse, status: number, body: string): void => { response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) }); response.end(body); };
    const control: NonNullable<CoreStrategy["control"]> = {
      prefix: FAKE_CONTROL_PREFIX,
      authorised,
      async handle(request, response, path) {
        if (!authorised(request)) return text(response, 403, "control token required");
        if (request.method === "GET" && path === `${FAKE_CONTROL_PREFIX}usage`) {
          const body = JSON.stringify(usage());
          response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
          response.end(body);
          return;
        }
        if (request.method === "POST" && path === `${FAKE_CONTROL_PREFIX}fault`) {
          let parsed: { name?: unknown; count?: unknown };
          try { parsed = JSON.parse(await readBoundedBody(request, 4_096)) as { name?: unknown; count?: unknown }; } catch { return text(response, 400, "a fault is JSON with a name and a count"); }
          const count = typeof parsed.count === "number" && Number.isInteger(parsed.count) && parsed.count >= 1 && parsed.count <= 1_000 ? parsed.count : 1;
          if (typeof parsed.name !== "string" || !faultByName.has(parsed.name)) return text(response, 404, "no such fault in this fixture set");
          armed.set(parsed.name, (armed.get(parsed.name) ?? 0) + count);
          return text(response, 204, "");
        }
        return text(response, 404, "no such control path");
      },
    };

    /** The armed fault the next request uses, oldest first, or undefined. */
    const takeFault = (): ServiceMockFault | undefined => {
      for (const [name, remaining] of armed) {
        if (remaining <= 0) { armed.delete(name); continue; }
        armed.set(name, remaining - 1);
        faultsInjected.set(name, (faultsInjected.get(name) ?? 0) + 1);
        return faultByName.get(name);
      }
      return undefined;
    };

    const faultAnswer = (fault: ServiceMockFault, requestSha256: string, host: string | null): CoreAnswer => {
      const status = fault.status ?? 500;
      const body = fault.kind === "throttle" ? "throttled" : "service error";
      const headers = errorTypeHeader ? { "x-amzn-errortype": fault.kind === "throttle" ? "ThrottlingException" : "InternalFailure" } : {};
      return { status: fault.kind === "timeout" ? 0 : status, contentType: "text/plain; charset=utf-8", text: body, headers, delayMs: fault.delayMs, destroy: fault.kind === "timeout",
        ledger: { outcome: "fault", host, entryHash: null, fault: fault.name, requestSha256, responseSha256: fault.kind === "timeout" ? sha("timeout") : fakeResponseDigest({ status, contentType: "text/plain; charset=utf-8", body }) } };
    };
    const noRecording = (outcome: FakeLedgerOutcome, request: { method: string; rawPath: string; host: string | null }, requestSha256: string, status = SERVICE_MOCK_UNMATCHED_STATUS, body = SERVICE_MOCK_NO_RECORDING_MESSAGE): CoreAnswer => ({
      status, contentType: "text/plain; charset=utf-8", text: body, headers: status === 413 ? { "x-rovara-mock": "no-recording", connection: "close" } : { "x-rovara-mock": "no-recording" },
      ledger: { outcome, host: request.host, entryHash: null, fault: null, requestSha256, responseSha256: fakeResponseDigest({ status, contentType: "text/plain; charset=utf-8", body }) },
    });

    // What a request with no recording is answered with (`fail` by default; `schema_synth` only when the set has a response schema the request satisfies). Either way it is counted.
    const unmatchedAnswer = (request: CoreRequest, hash: string, host: string | null, addressed: boolean): CoreAnswer => {
      if (options.unmatched === "schema_synth" && addressed && set.responseSchema !== undefined) {
        let acceptable = set.requestSchema === undefined;
        if (set.requestSchema !== undefined) {
          try { acceptable = schemaAccepts(set.requestSchema, JSON.parse(request.body) as unknown); } catch { acceptable = false; }
        }
        if (acceptable) {
          counts.synthesized += 1;
          const body = JSON.stringify(synthesizeFromSchema(set.responseSchema, createSyntheticGenerator(parseInt(hash.slice(0, 7), 16))));
          return { status: 200, contentType: "application/json", text: body, headers: { "x-rovara-mock": "synthesized" },
            ledger: { outcome: "synthesized", host, entryHash: null, fault: null, requestSha256: hash, responseSha256: fakeResponseDigest({ status: 200, contentType: "application/json", body }) } };
        }
      }
      counts.unmatchedFailed += 1;
      return noRecording("unmatched", { method: request.method, rawPath: request.rawPath, host }, hash);
    };

    strategy = {
      maxBodyBytes: SERVICE_MOCK_BODY_MAX_BYTES,
      control,
      decide(request, context) {
        const host = hostOf(request);
        const idle = { method: request.method, rawPath: request.rawPath, host };
        if (context.full) { counts.unmatchedFailed += 1; return unmocked("overflow", idle); }
        if (isForeign(request.remote)) { counts.foreignCalls += 1; return unmocked("foreign-caller", idle); }
        // A SageMaker-shaped endpoint is addressed by name: another endpoint, or any other path, is a request this set has no recording for, and it does not use up an armed fault.
        const addressed = request.originForm && (set.dependency.protocol !== "model_invoke" || sagemakerEndpointOfPath(request.rawPath) === set.dependency.target);
        const hash = addressed
          ? fixtureRequestHash(set, { method: request.method, path: request.rawPath, query: queryPairs(request.rawQuery), contentType: String(request.headers["content-type"] ?? ""), body: request.body })
          : sha(canonicalJson({ method: clip(request.method, 16), path: clip(request.rawPath, 512), host }));
        const fault = addressed ? takeFault() : undefined;
        if (fault !== undefined) return faultAnswer(fault, hash, host);
        const base = addressed ? entries.get(hash) : undefined;
        const added = addressed && base === undefined ? additions.get(hash) : undefined;
        const entry = base ?? added;
        if (entry === undefined) return unmatchedAnswer(request, hash, host, addressed);
        // A status below 200 is not an answer a client can be given; such an entry is counted as unplaceable rather than sent.
        if (entry.response.status < 200) { counts.unmatchedFailed += 1; return noRecording("unplaced", idle, hash); }
        if (added === undefined) counts.matched += 1; else counts.additionsServed += 1;
        return {
          status: entry.response.status, contentType: entry.response.contentType, text: entry.response.body,
          headers: { ...allowedResponseHeaders(entry.response.headers), ...(set.dependency.protocol === "model_invoke" ? { "x-amzn-invoked-production-variant": "AllTraffic" } : {}) },
          ...(options.replayLatency === true && entry.response.latencyMs > 0 ? { delayMs: entry.response.latencyMs } : {}),
          ledger: { outcome: added === undefined ? "matched" : "addition", host, entryHash: entry.requestHash, fault: null, requestSha256: hash,
            responseSha256: fakeResponseDigest({ status: entry.response.status, contentType: entry.response.contentType, body: entry.response.body }) },
        };
      },
      refuse(call: CoreRefusal) {
        counts.unmatchedFailed += 1;
        const outcome: FakeLedgerOutcome = call.kind === "refused" ? "refused" : call.kind === "dropped" ? "dropped" : call.kind === "body-too-large" ? "too-large" : "unparsed";
        const idle = { method: call.method, rawPath: call.rawPath, host: null };
        const requestSha256 = sha(canonicalJson({ method: clip(call.method, 16), path: clip(call.rawPath, 512), host: null }));
        if (call.kind === "body-too-large") return noRecording(outcome, idle, requestSha256, 413, "request too large");
        return { ...unmocked(outcome, idle, requestSha256) };
      },
    };
  }

  const running: RunningCore = await startCore({
    strategy, ledgerPath: options.ledgerPath, host: options.bindAddress, port: options.port ?? 0,
    ...(options.additionalPorts === undefined ? {} : { additionalPorts: options.additionalPorts }),
    ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }), ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.connectionGraceMs === undefined ? {} : { connectionGraceMs: options.connectionGraceMs }), ...(options.connectionCeilingMs === undefined ? {} : { connectionCeilingMs: options.connectionCeilingMs }),
    ...(options.now === undefined ? {} : { now: options.now }), ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
    keepAliveMs: 2_000,
  });
  // The kernel's answer is the proof: every listener is on the run address and on no other.
  for (const server of running.servers) {
    const address = server.address();
    if (address === null || typeof address === "string" || address.address !== options.bindAddress) {
      await running.close();
      throw new FakeServerRefused("bind_address");
    }
  }
  const first = running.servers[0]!.address();
  const shown = first !== null && typeof first !== "string" && first.family === "IPv6" ? `[${first.address}]` : (first as { address: string }).address;
  return { url: `http://${shown}:${String(running.port)}`, ports: running.ports, controlToken, usage, close: running.close };
}

/**
 * The E2E checker's GET fixture, served by the fake server: converted to a v2 set (each variant an entry keyed by its query value) and pinned by the digest of that conversion. `host` is the origin
 * the fixture stands for. The container entry point (`executor/mock-server.ts`) keeps its own package-free copy of the same answers, and a test holds the two together.
 */
export function startFakeFromE2eFixture(fixture: E2EApiMockFixture, options: Omit<FakeReplayOptions, "mode" | "fixtureSet" | "expectedDigest" | "unmatched"> & { host: string; revision?: number }): Promise<RunningFakeServer> {
  const converted = e2eApiMockFixtureToFixtureSet(fixture, { host: options.host, ...(options.revision === undefined ? {} : { revision: options.revision }) });
  if (!converted.ok) throw new FixtureSetRefused("unreadable");
  return startFakeServer({ ...options, mode: "replay", fixtureSet: converted.set, expectedDigest: fixtureSetDigest(converted.set), unmatched: "fail" });
}
