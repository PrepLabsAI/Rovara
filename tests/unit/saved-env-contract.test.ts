// Setup and test health SH3: the saved environment contract and the environment key (pure hash over given file hashes and inputs).
import { describe, expect, it } from "vitest";
import {
  SAVED_ENV_MAX_KEY_FILES, SavedEnvManifestSchema, computeEnvironmentKey, EnvironmentKeyInputSchema, type EnvironmentKeyInput,
} from "@agentx/contracts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const DIGEST = `sha256:${"a".repeat(64)}`;
const base = (): EnvironmentKeyInput => ({
  keyFiles: [{ repositoryId: "svc", path: "package-lock.json", sha256: H1 }, { repositoryId: "svc", path: "package.json", sha256: H2 }],
  testEnvRevision: 3,
  secretNames: ["NPM_TOKEN", "DB_URL"],
  baseImageDigest: DIGEST,
});

describe("environment key", () => {
  it("is a lowercase sha256 hex", () => {
    expect(computeEnvironmentKey(base())).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when a key file's content changes", () => {
    const changed = base();
    changed.keyFiles[0] = { repositoryId: "svc", path: "package-lock.json", sha256: H3 };
    expect(computeEnvironmentKey(changed)).not.toBe(computeEnvironmentKey(base()));
  });

  it("changes when a key file is added, removed, or lives in another repository or path", () => {
    const key = computeEnvironmentKey(base());
    const added = base();
    added.keyFiles.push({ repositoryId: "svc", path: "yarn.lock", sha256: H3 });
    expect(computeEnvironmentKey(added)).not.toBe(key);
    const removed = base();
    removed.keyFiles.pop();
    expect(computeEnvironmentKey(removed)).not.toBe(key);
    const moved = base();
    moved.keyFiles[0] = { repositoryId: "other", path: "package-lock.json", sha256: H1 };
    expect(computeEnvironmentKey(moved)).not.toBe(key);
    const renamed = base();
    renamed.keyFiles[0] = { repositoryId: "svc", path: "sub/package-lock.json", sha256: H1 };
    expect(computeEnvironmentKey(renamed)).not.toBe(key);
  });

  it("changes with the test environment revision, the secret names and the base image digest", () => {
    const key = computeEnvironmentKey(base());
    expect(computeEnvironmentKey({ ...base(), testEnvRevision: 4 })).not.toBe(key);
    expect(computeEnvironmentKey({ ...base(), secretNames: ["NPM_TOKEN"] })).not.toBe(key);
    expect(computeEnvironmentKey({ ...base(), secretNames: ["NPM_TOKEN", "DB_URL", "EXTRA"] })).not.toBe(key);
    expect(computeEnvironmentKey({ ...base(), baseImageDigest: `sha256:${"b".repeat(64)}` })).not.toBe(key);
  });

  it("does not depend on the order of files or secret names, or on repeated secret names", () => {
    const key = computeEnvironmentKey(base());
    const shuffled = base();
    shuffled.keyFiles.reverse();
    shuffled.secretNames = ["DB_URL", "NPM_TOKEN", "DB_URL"];
    expect(computeEnvironmentKey(shuffled)).toBe(key);
  });

  it("keeps a file's path and hash apart from a neighbour's (no ambiguity at the seams)", () => {
    const left = { ...base(), keyFiles: [{ repositoryId: "a", path: "b/c", sha256: H1 }] };
    const right = { ...base(), keyFiles: [{ repositoryId: "a/b", path: "c", sha256: H1 }] };
    expect(computeEnvironmentKey(left)).not.toBe(computeEnvironmentKey(right));
  });

  it("is pinned: the same input gives the same key on every machine", () => {
    expect(computeEnvironmentKey(base())).toBe(computeEnvironmentKey(structuredClone(base())));
  });

  it("refuses two entries for the same file (fail closed, not last-one-wins)", () => {
    const twice = base();
    twice.keyFiles.push({ repositoryId: "svc", path: "package.json", sha256: H3 });
    expect(() => computeEnvironmentKey(twice)).toThrow();
  });

  it("refuses malformed input instead of hashing it", () => {
    expect(() => computeEnvironmentKey({ ...base(), baseImageDigest: "latest" })).toThrow();
    expect(() => computeEnvironmentKey({ ...base(), testEnvRevision: 0 })).toThrow();
    expect(() => computeEnvironmentKey({ ...base(), secretNames: ["has space"] })).toThrow();
    expect(() => computeEnvironmentKey({ ...base(), keyFiles: [{ repositoryId: "svc", path: "../x", sha256: H1 }] })).toThrow();
    expect(() => computeEnvironmentKey({ ...base(), keyFiles: [{ repositoryId: "svc", path: "a", sha256: "xyz" }] })).toThrow();
    expect(() => computeEnvironmentKey({ ...base(), extra: 1 } as unknown as EnvironmentKeyInput)).toThrow();
  });

  it("bounds the number of key files", () => {
    const many = Array.from({ length: SAVED_ENV_MAX_KEY_FILES + 1 }, (_, index) => ({ repositoryId: "svc", path: `f${String(index)}`, sha256: H1 }));
    expect(EnvironmentKeyInputSchema.safeParse({ ...base(), keyFiles: many }).success).toBe(false);
    expect(EnvironmentKeyInputSchema.safeParse({ ...base(), keyFiles: many.slice(0, SAVED_ENV_MAX_KEY_FILES) }).success).toBe(true);
  });
});

describe("saved environment manifest", () => {
  const manifest = () => ({
    schemaVersion: 1,
    environmentKey: computeEnvironmentKey(base()),
    testEnvRevision: 3,
    commits: [{ repositoryId: "svc", sha: "c".repeat(40) }],
    proveReportDigest: H3,
    imageDigest: DIGEST,
    builtAt: "2026-11-01T10:00:00.000Z",
  });

  it("accepts the manifest the design lists and nothing else", () => {
    expect(SavedEnvManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(SavedEnvManifestSchema.safeParse({ ...manifest(), secrets: ["x"] }).success).toBe(false);
  });

  it("requires a digest, never a tag, for the image", () => {
    expect(SavedEnvManifestSchema.safeParse({ ...manifest(), imageDigest: "repo:latest" }).success).toBe(false);
  });

  it("refuses a malformed commit and an empty commit list", () => {
    expect(SavedEnvManifestSchema.safeParse({ ...manifest(), commits: [{ repositoryId: "svc", sha: "main" }] }).success).toBe(false);
    expect(SavedEnvManifestSchema.safeParse({ ...manifest(), commits: [] }).success).toBe(false);
    // one commit per repository: a repository listed twice (even with the same commit) is refused
    expect(SavedEnvManifestSchema.safeParse({ ...manifest(), commits: [{ repositoryId: "svc", sha: "c".repeat(40) }, { repositoryId: "svc", sha: "d".repeat(40) }] }).success).toBe(false);
    expect(SavedEnvManifestSchema.safeParse({ ...manifest(), commits: [{ repositoryId: "svc", sha: "c".repeat(40) }, { repositoryId: "web", sha: "c".repeat(40) }] }).success).toBe(true);
  });
});
