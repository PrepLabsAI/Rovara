import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONTAINED_IMAGE,
  CONTAINED_SOCKET,
  buildCreateArgs,
  isOwnedContainer,
  runContainedCandidate,
  validateCandidatePacket,
  validateRequest,
} from "../../packages/verifier/src/contained-candidate.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const packet = (path = "candidate.mjs", contents = "export default async (input) => input;") => ({
  schemaVersion: 1 as const,
  entry: path,
  files: [{ path, bytes: new TextEncoder().encode(contents), sha256: hash(contents) }],
});

describe("contained candidate foundation", () => {
  it("validates an immutable byte and digest packet and rejects traversal or digest drift", () => {
    expect(validateCandidatePacket(packet()).entry).toBe("candidate.mjs");
    expect(() => validateCandidatePacket(packet("../outside.mjs"))).toThrow(/path/i);
    expect(() => validateCandidatePacket({ ...packet(), unexpected: true })).toThrow(/shape/i);
    const lower = new TextEncoder().encode("export default () => 1;");
    const aliasPacket = packet();
    expect(() => validateCandidatePacket({ ...aliasPacket, files: [...aliasPacket.files, { path: "Candidate.mjs", bytes: lower, sha256: hash("export default () => 1;") }] })).toThrow(/collision/i);
    const wrongDigest = packet();
    wrongDigest.files[0]!.sha256 = "0".repeat(64);
    expect(() => validateCandidatePacket(wrongDigest)).toThrow(/digest/i);
    const unicode = packet("café résumé #?.mjs");
    const unicodeSidecar = { path: "fixtures/naïve café.txt", bytes: new TextEncoder().encode("unicode sidecar"), sha256: hash("unicode sidecar") };
    expect(validateCandidatePacket({ ...unicode, files: [...unicode.files, unicodeSidecar] }).entry).toBe("café résumé #?.mjs");
    const githubMeta = { path: ".github/workflows/check.yml", bytes: new TextEncoder().encode("on: push"), sha256: hash("on: push") };
    expect(validateCandidatePacket({ ...packet(), files: [...packet().files, githubMeta] }).entry).toBe("candidate.mjs");
    const foldedAlias = { path: "STRASSE.mjs", bytes: lower, sha256: hash("export default () => 1;") };
    const sharpS = { path: "Straße.mjs", bytes: lower, sha256: hash("export default () => 1;") };
    expect(() => validateCandidatePacket({ ...packet(), files: [packet().files[0], foldedAlias, sharpS] })).toThrow(/collision/i);
    const prefixCollision = { path: "candidate.mjs/child.mjs", bytes: lower, sha256: hash("export default () => 1;") };
    expect(() => validateCandidatePacket({ ...packet(), files: [packet().files[0], prefixCollision] })).toThrow(/collision/i);
  });

  it("rejects byte-view accessors before running them and preserves valid Buffer slices", () => {
    for (const key of ["buffer", "byteLength", "byteOffset", "constructor", Symbol.iterator]) {
      const bytes = new TextEncoder().encode("export default () => 1;");
      let getterRuns = 0;
      Object.defineProperty(bytes, key, { configurable: true, get: () => { getterRuns += 1; return bytes.buffer; } });
      expect(() => validateCandidatePacket({ schemaVersion: 1, entry: "candidate.mjs", files: [{ path: "candidate.mjs", bytes, sha256: hash("export default () => 1;") }] })).toThrow(/custom|accessor|byte/i);
      expect(getterRuns).toBe(0);
    }

    const backing = Buffer.from("xxexport default () => 1;yy");
    const slice = backing.subarray(2, -2);
    const admitted = validateCandidatePacket({ schemaVersion: 1, entry: "candidate.mjs", files: [{ path: "candidate.mjs", bytes: slice, sha256: hash("export default () => 1;") }] });
    backing.fill(0);
    expect(new TextDecoder().decode(admitted.files[0]!.bytes)).toBe("export default () => 1;");
  });

  it("bounds arbitrary JSON input by encoded bytes and nesting depth", () => {
    expect(validateRequest({ requestId: "req-1", input: { name: "synthetic" } }).requestId).toBe("req-1");
    expect(() => validateRequest({ requestId: "", input: null })).toThrow(/request/i);
    expect(() => validateRequest({ requestId: "x", input: null, callerField: true })).toThrow(/request/i);
    expect(validateRequest({ requestId: "near-limit", input: "a".repeat(65_534) }).requestId).toBe("near-limit");
    expect(() => validateRequest({ requestId: "x", input: "a".repeat(65_535) })).toThrow(/size/i);
    let deep: unknown = "leaf";
    for (let index = 0; index < 34; index += 1) deep = [deep];
    expect(() => validateRequest({ requestId: "deep", input: deep })).toThrow(/depth/i);
  });

  it("builds only the fixed Docker containment profile and explicit local endpoint", () => {
    const args = buildCreateArgs({ name: "agentx-contained-0123456789abcdefabcd", cidfile: "/tmp/ax/cid", sourcePath: "/tmp/ax/source", entry: "café #?.mjs", sourceDigest: "a".repeat(64), nonce: "a".repeat(48) });
    expect(args).toContain(CONTAINED_IMAGE);
    expect(args).toContain("--pull=never");
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges:true");
    expect(args).toContain("--pids-limit=256");
    expect(args).toContain("--cpus=2");
    expect(args).toContain("--memory=4096m");
    expect(args).toContain("--memory-swap=4096m");
    expect(args).toContain("--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m");
    expect(args.join(" ")).not.toMatch(/docker\.sock|hosthome|node_modules/);
    expect(args.at(-1)).toBe("/candidate/.agentx-bootstrap.mjs");
    expect(args).toContain("AGENTX_ENTRY=/candidate/café #?.mjs");
    expect(args).toContain("AGENTX_EXPORT=default");
    expect(CONTAINED_SOCKET).toBe("unix:///Users/abhishekgarg/.colima/default/docker.sock");
    expect(() => buildCreateArgs({ name: "agentx-contained-0123456789abcdefabcd", cidfile: "/tmp/ax,cid", sourcePath: "/tmp/ax/source", entry: "candidate.mjs", sourceDigest: "a".repeat(64), nonce: "a".repeat(48) })).toThrow(/input/i);
  });

  it("only authorizes cleanup when exact owner labels and nonce match", () => {
    const owner = { nonce: "nonce-a", sourceDigest: "a".repeat(64) };
    const labels = { "agentx.owner": "contained-candidate-v1", "agentx.nonce": owner.nonce, "agentx.source": owner.sourceDigest };
    expect(isOwnedContainer(labels, owner)).toBe(true);
    expect(isOwnedContainer({ ...labels, "agentx.nonce": "nonce-b" }, owner)).toBe(false);
    expect(isOwnedContainer({ ...labels, "agentx.owner": "foreign" }, owner)).toBe(false);
    expect(isOwnedContainer(undefined, owner)).toBe(false);
  });

  it("copies only descriptor-backed JSON without invoking getters, serializers, or proxy traps", () => {
    let getterRuns = 0;
    const input = {};
    Object.defineProperty(input, "effect", { enumerable: true, get: () => { getterRuns += 1; return "must not run"; } });
    expect(() => validateRequest({ requestId: "descriptor", input })).toThrow(/accessor|JSON|data/i);
    expect(getterRuns).toBe(0);

    let proxyTraps = 0;
    const proxy = new Proxy({}, { ownKeys: () => { proxyTraps += 1; return []; } });
    expect(() => validateRequest({ requestId: "proxy", input: proxy })).toThrow(/proxy|JSON|input/i);
    expect(proxyTraps).toBe(0);

    let serializerRuns = 0;
    const withSerializer = { toJSON: () => { serializerRuns += 1; return "wrong"; } };
    expect(() => validateRequest({ requestId: "serializer", input: withSerializer })).toThrow(/function|JSON|value/i);
    expect(serializerRuns).toBe(0);
    expect(validateRequest({ requestId: "plain-to-json", input: { toJSON: "ordinary data" } }).input).toEqual({ toJSON: "ordinary data" });
    expect(() => validateRequest({ requestId: "non-json", input: { nan: Number.NaN, missing: undefined } })).toThrow(/JSON|finite|undefined/i);
    const sparse: unknown[] = [];
    sparse.length = 3;
    sparse[0] = 1;
    sparse[2] = 3;
    expect(() => validateRequest({ requestId: "sparse", input: sparse })).toThrow(/sparse|array|JSON/i);
    const custom = new (class { own = 1; })();
    expect(() => validateRequest({ requestId: "prototype", input: custom })).toThrow(/prototype|plain|JSON/i);
  });

  it("rejects accessor execution options before preparing or spawning Docker", async () => {
    let getterRuns = 0;
    const options = {};
    Object.defineProperty(options, "signal", { enumerable: true, get: () => { getterRuns += 1; return new AbortController().signal; } });
    await expect(runContainedCandidate(packet(), { requestId: "options-accessor", input: null }, options)).rejects.toThrow(/accessor|execution options/i);
    expect(getterRuns).toBe(0);
  });

  it("rejects case-folded prefix aliases and credential/control paths before materialization", () => {
    const bytes = new TextEncoder().encode("x");
    const child = { path: "a/b", bytes, sha256: hash("x") };
    for (const alias of ["．env.local", ".GIT/config", ".ssh/id_rsa", ".AWS/credentials", ".Docker/config.json", ".npmrc", ".config/credentials.json"]) {
      const parent = { path: alias, bytes, sha256: hash("x") };
      expect(() => validateCandidatePacket({ ...packet(), files: [packet().files[0], parent] })).toThrow(/collision|reserved|path/i);
    }
    const sharpS = { path: "Straße.mjs", bytes, sha256: hash("x") };
    const strasse = { path: "STRASSE.mjs", bytes, sha256: hash("x") };
    expect(() => validateCandidatePacket({ ...packet(), files: [packet().files[0], sharpS, strasse] })).toThrow(/collision/i);
    const prefixParent = { path: "A", bytes, sha256: hash("x") };
    expect(() => validateCandidatePacket({ ...packet(), files: [packet().files[0], prefixParent, child] })).toThrow(/collision/i);
  });

  it("preserves literal request JSON limits while rejecting deeply nested data", () => {
    let atLimit: unknown = "leaf";
    for (let index = 0; index < 32; index += 1) atLimit = [atLimit];
    expect(validateRequest({ requestId: "depth-32", input: atLimit }).requestId).toBe("depth-32");
    expect(() => validateRequest({ requestId: "depth-33", input: [atLimit] })).toThrow(/depth/i);
  });
});
