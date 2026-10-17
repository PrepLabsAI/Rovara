import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, createCandidateManifest, E2EApplicationBuildSourceManifestSchema,
  E2EApplicationBuildSourceRefSchema } from "@agentx/contracts";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function gitBlob(bytes: Uint8Array): string {
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest("hex");
}
function gitTree(name: string, mode: string, objectId: string): string {
  const entry = Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(objectId, "hex")]);
  return createHash("sha1").update(Buffer.concat([Buffer.from(`tree ${entry.byteLength}\0`), entry])).digest("hex");
}

describe("strict application execution wire contracts", () => {
  it("binds complete candidate tree inventory and canonical archive reference", () => {
    const bytes = Buffer.from("export const app = true;\n");
    const path = "src/app.js";
    const blob = gitBlob(bytes);
    const treeSha = gitTree("src", "40000", gitTree("app.js", "100644", blob));
    const candidate = createCandidateManifest([{ repositoryId: "app-repo", commitSha: "a".repeat(40), treeSha }]);
    const archive = canonicalJson({ schemaVersion: "e2e-application-build-source-archive/v1",
      files: [{ path, mode: "100644", bytesBase64: bytes.toString("base64") }] });
    const manifestBody = {
      schemaVersion: "e2e-application-build-source-manifest/v1" as const,
      candidateDigest: candidate.digest,
      repository: { repositoryId: "app-repo", commitSha: "a".repeat(40), treeSha },
      sourceState: "committed-tree" as const, pathPolicy: "existing-safe-e2e-source-path/v1" as const,
      treeEntries: [{ path, mode: "100644" as const, objectId: blob }],
      files: [{ path, mode: "100644" as const, gitBlobId: blob, sha256: sha(bytes), byteLength: bytes.byteLength }],
      omissions: [],
      archive: { format: "e2e-application-build-source-archive/v1" as const, sha256: sha(archive), byteLength: Buffer.byteLength(archive), fileCount: 1 },
    };
    const manifest = { ...manifestBody, manifestDigest: sha(canonicalJson(manifestBody)) };
    expect(E2EApplicationBuildSourceManifestSchema.safeParse(manifest).success).toBe(true);
    expect(E2EApplicationBuildSourceRefSchema.safeParse({ artifactId: "private-build-source", sha256: sha(archive),
      byteLength: Buffer.byteLength(archive), manifestDigest: manifest.manifestDigest }).success).toBe(true);
    expect(E2EApplicationBuildSourceManifestSchema.safeParse({ ...manifest, secret: "no" }).success).toBe(false);
    expect(E2EApplicationBuildSourceManifestSchema.safeParse({ ...manifest, treeEntries: [] }).success).toBe(false);
  });
});
