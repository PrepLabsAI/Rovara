import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createE2EApplicationArtifactStoreForConformance } from "../../packages/verifier/src/host/artifact-store.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const binding = {
  schemaVersion: "e2e-application-host-preparation/v1",
  preparationId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  operationId: "44444444-4444-4444-8444-444444444444",
  operationFence: 1,
  workflowRevision: 1,
  candidateDigest: "a".repeat(64),
  planDigest: "b".repeat(64),
  intentDigest: "c".repeat(64),
  groupId: "group-1",
  runtimeProfileId: "linux-web-api/v1",
  runtimeManifestDigest: "d".repeat(64),
  networkPolicyDigest: "e".repeat(64),
  admittedAt: "2026-10-17T12:00:00.000Z",
  preparationDeadlineAt: "2026-10-17T12:01:00.000Z",
  deadlineAt: "2026-10-17T12:02:00.000Z",
} as const;

describe("application artifact store", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("opens only catalog-bound bytes and serves bounded ordered chunks whose hash matches the artifact ref", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agentx-artifact-store-")));
    const dataRoot = join(root, "artifacts");
    await mkdir(dataRoot, { mode: 0o700 });
    const bytes = Buffer.from("{" + "\"candidate\":\"sealed\"}".repeat(5000));
    const artifactPath = join(dataRoot, "orders.tar");
    await writeFile(artifactPath, bytes, { mode: 0o600 });
    const artifact = { artifactId: "artifact-1", sha256: digest(bytes), appId: "orders", platform: "web", buildManifestDigest: "f".repeat(64) } as const;
    const store = createE2EApplicationArtifactStoreForConformance({
      privateRoot: dataRoot,
      catalog: {
        resolve: async ({ artifactId, binding: receivedBinding }) => {
          expect(artifactId).toBe(artifact.artifactId);
          expect(receivedBinding).toEqual(binding);
          return { path: artifactPath, formatId: "e2e-app-archive/v1", artifact, candidateDigest: binding.candidateDigest };
        },
      },
    });

    const opened = await store.open({ artifact, binding }, new AbortController().signal);
    expect(opened.byteLength).toBe(bytes.byteLength);
    expect(opened.sha256).toBe(digest(bytes));
    expect(opened.formatId).toBe("e2e-app-archive/v1");
    const first = await opened.readChunk(0, new AbortController().signal);
    expect(first.offset).toBe(0);
    expect(first.totalBytes).toBe(bytes.byteLength);
    expect(first.bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(first.sha256).toBe(digest(first.bytes));
    await expect(opened.readChunk(bytes.byteLength - 3, new AbortController().signal)).rejects.toThrow(/ordered/);
    const rest = await opened.readChunk(first.bytes.byteLength, new AbortController().signal);
    expect(rest.bytes).toEqual(Uint8Array.from(bytes.subarray(first.bytes.byteLength)));
    await expect(opened.readChunk(bytes.byteLength, new AbortController().signal)).rejects.toThrow(/ordered/);
    await opened.close();
    await expect(opened.readChunk(0, new AbortController().signal)).rejects.toThrow();
  });

  it("rejects a catalog path outside the fixed private root before reading bytes", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agentx-artifact-store-")));
    const privateRoot = join(root, "private");
    await mkdir(privateRoot);
    const foreignPath = join(root, "foreign.tar");
    const bytes = Buffer.from("foreign");
    await writeFile(foreignPath, bytes, { mode: 0o600 });
    const artifact = { artifactId: "artifact-1", sha256: digest(bytes), appId: "orders", platform: "api", buildManifestDigest: "f".repeat(64) } as const;
    const store = createE2EApplicationArtifactStoreForConformance({ privateRoot, catalog: {
      resolve: async () => ({ path: foreignPath, formatId: "e2e-app-archive/v1", artifact, candidateDigest: binding.candidateDigest }),
    } });
    await expect(store.open({ artifact, binding }, new AbortController().signal)).rejects.toThrow();
  });

  it("rejects changed file bytes even when the catalog returns the expected artifact identifier", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agentx-artifact-store-")));
    const path = join(root, "artifact.tar");
    await writeFile(path, "changed", { mode: 0o600 });
    const claimed = Buffer.from("approved");
    const artifact = { artifactId: "artifact-1", sha256: digest(claimed), appId: "orders", platform: "web", buildManifestDigest: "f".repeat(64) } as const;
    const store = createE2EApplicationArtifactStoreForConformance({ privateRoot: root, catalog: {
      resolve: async () => ({ path, formatId: "e2e-app-archive/v1", artifact, candidateDigest: binding.candidateDigest }),
    } });
    await expect(store.open({ artifact, binding }, new AbortController().signal)).rejects.toThrow();
  });

  it("rejects an artifact whose file permissions expose protected bytes", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agentx-artifact-store-")));
    const bytes = Buffer.from("private artifact");
    const path = join(root, "artifact.tar");
    await writeFile(path, bytes, { mode: 0o644 });
    const artifact = { artifactId: "artifact-1", sha256: digest(bytes), appId: "orders", platform: "web", buildManifestDigest: "f".repeat(64) } as const;
    const store = createE2EApplicationArtifactStoreForConformance({ privateRoot: root, catalog: {
      resolve: async () => ({ path, formatId: "e2e-app-archive/v1", artifact, candidateDigest: binding.candidateDigest }),
    } });
    await expect(store.open({ artifact, binding }, new AbortController().signal)).rejects.toThrow(/private canonical/);
  });
});
