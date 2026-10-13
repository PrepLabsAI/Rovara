import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONTAINED_IMAGE,
  CONTAINED_SOCKET,
  buildCreateArgs,
  isOwnedContainer,
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
    const foldedAlias = { path: "STRASSE.mjs", bytes: lower, sha256: hash("export default () => 1;") };
    const sharpS = { path: "Straße.mjs", bytes: lower, sha256: hash("export default () => 1;") };
    expect(() => validateCandidatePacket({ ...packet(), files: [packet().files[0], foldedAlias, sharpS] })).toThrow(/collision/i);
    const prefixCollision = { path: "candidate.mjs/child.mjs", bytes: lower, sha256: hash("export default () => 1;") };
    expect(() => validateCandidatePacket({ ...packet(), files: [packet().files[0], prefixCollision] })).toThrow(/collid/i);
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
    const args = buildCreateArgs({ name: "agentx-contained-0123456789abcdefabcd", cidfile: "/tmp/ax/cid", sourcePath: "/tmp/ax/source", bootstrapPath: "/tmp/ax/bootstrap.mjs", entry: "café #?.mjs", sourceDigest: "a".repeat(64), nonce: "a".repeat(48) });
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
    expect(args).toContain("AGENTX_ENTRY=/candidate/café #?.mjs");
    expect(CONTAINED_SOCKET).toBe("unix:///Users/abhishekgarg/.colima/default/docker.sock");
    expect(() => buildCreateArgs({ name: "agentx-contained-0123456789abcdefabcd", cidfile: "/tmp/ax,cid", sourcePath: "/tmp/ax/source", bootstrapPath: "/tmp/ax/bootstrap.mjs", entry: "candidate.mjs", sourceDigest: "a".repeat(64), nonce: "a".repeat(48) })).toThrow(/input/i);
  });

  it("only authorizes cleanup when exact owner labels and nonce match", () => {
    const owner = { nonce: "nonce-a", sourceDigest: "a".repeat(64) };
    const labels = { "agentx.owner": "contained-candidate-v1", "agentx.nonce": owner.nonce, "agentx.source": owner.sourceDigest };
    expect(isOwnedContainer(labels, owner)).toBe(true);
    expect(isOwnedContainer({ ...labels, "agentx.nonce": "nonce-b" }, owner)).toBe(false);
    expect(isOwnedContainer({ ...labels, "agentx.owner": "foreign" }, owner)).toBe(false);
    expect(isOwnedContainer(undefined, owner)).toBe(false);
  });
});
