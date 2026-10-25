import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2E_APPLICATION_ADMISSION_SCHEMA_V1, E2E_APPLICATION_ADMISSION_SCHEMA_V2, E2EApplicationExecutionAdmissionSchema, canonicalJson, createCandidateManifest,
  E2EApplicationBuildSourceManifestSchema, E2EApplicationBuildSourceRefSchema, e2eRuntimeBindingKey, e2eRuntimeBindingOf, isE2EApplicationAdmissionSchemaVersion } from "@agentx/contracts";
import { webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";

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

describe("runtime bindings keyed by profile and kind (Task 3.4)", () => {
  const web = webApiRow("web");
  const api = webApiRow("api");

  it("names a row by its profile and kind, the same suffix as the catalog row's sort key", () => {
    expect(e2eRuntimeBindingKey("linux-arm64-web-api-v1", "web")).toBe("linux-arm64-web-api-v1#web");
    expect(e2eRuntimeBindingKey("linux-arm64-web-api-v1", "api")).toBe("linux-arm64-web-api-v1#api");
  });

  it("finds the row of the asked kind under a kind key, and never the other kind's row of the same profile", () => {
    const bindings = new Map([[e2eRuntimeBindingKey(web.profileId, "web"), web], [e2eRuntimeBindingKey(api.profileId, "api"), api]]);
    expect(e2eRuntimeBindingOf(bindings, web.profileId, "web")).toBe(web);
    expect(e2eRuntimeBindingOf(bindings, web.profileId, "api")).toBe(api);
    // A key that says one kind and holds the other finds nothing.
    const swapped = new Map([[e2eRuntimeBindingKey(web.profileId, "web"), api]]);
    expect(e2eRuntimeBindingOf(swapped, web.profileId, "web")).toBeUndefined();
  });

  it("reads a version 1 map, which keyed its one row by the profile alone, only for the kind that row is", () => {
    const legacy = new Map([[web.profileId, web]]);
    expect(e2eRuntimeBindingOf(legacy, web.profileId, "web")).toBe(web);
    expect(e2eRuntimeBindingOf(legacy, web.profileId, "api")).toBeUndefined();
    expect(e2eRuntimeBindingOf(new Map(), web.profileId, "web")).toBeUndefined();
  });

  it("knows both admission versions as application admissions, and nothing else", () => {
    expect(E2E_APPLICATION_ADMISSION_SCHEMA_V2).not.toBe(E2E_APPLICATION_ADMISSION_SCHEMA_V1);
    for (const version of [E2E_APPLICATION_ADMISSION_SCHEMA_V1, E2E_APPLICATION_ADMISSION_SCHEMA_V2]) expect(isE2EApplicationAdmissionSchemaVersion(version), version).toBe(true);
    for (const other of ["workflow-e2e-admission/v1", "workflow-e2e-application-admission/v3", "workflow-e2e-application-admission", undefined, 2, null]) {
      expect(isE2EApplicationAdmissionSchemaVersion(other), String(other)).toBe(false);
    }
  });

  describe("the admission schema", () => {
    // The probe plan is the very code that wrote version 1 admissions: its admission is the stored shape the schema must keep reading.
    const stored = createOrdersExecutorPlan({ probe: "api-status-mismatch-v1", taskId: "44444444-4444-4444-8444-444444444444" }).plan.admission;
    const resign = (edit: (body: Record<string, unknown>) => void) => {
      const { admissionDigest: _digest, ...body } = stored;
      void _digest;
      const edited = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
      edit(edited);
      return { ...edited, admissionDigest: sha(canonicalJson(edited)) };
    };
    const kindOf = (value: { capabilities: { kind: string } }) => value.capabilities.kind as "web" | "api";

    it("still decodes an admission stored as version 1, keyed by the profile alone", () => {
      expect(stored.schemaVersion).toBe(E2E_APPLICATION_ADMISSION_SCHEMA_V1);
      expect(stored.runtimeBindings.map((item) => item.key)).toEqual(stored.runtimeBindings.map((item) => item.value.profileId));
      expect(E2EApplicationExecutionAdmissionSchema.safeParse(stored).success).toBe(true);
    });

    it("decodes the same admission as version 2 once its rows are keyed by profile and kind, and by no other keys", () => {
      const rekeyed = resign((body) => {
        body.schemaVersion = E2E_APPLICATION_ADMISSION_SCHEMA_V2;
        body.runtimeBindings = stored.runtimeBindings.map((item) => ({ key: e2eRuntimeBindingKey(item.value.profileId, kindOf(item.value)), value: item.value }));
      });
      expect(E2EApplicationExecutionAdmissionSchema.safeParse(rekeyed).success).toBe(true);
      // Version 2 with a key that lacks the kind, or names another kind than its row, is refused.
      expect(E2EApplicationExecutionAdmissionSchema.safeParse(resign((body) => { body.schemaVersion = E2E_APPLICATION_ADMISSION_SCHEMA_V2; })).success).toBe(false);
      const other = kindOf(stored.runtimeBindings[0]!.value) === "web" ? "api" : "web";
      expect(E2EApplicationExecutionAdmissionSchema.safeParse(resign((body) => {
        body.schemaVersion = E2E_APPLICATION_ADMISSION_SCHEMA_V2;
        body.runtimeBindings = stored.runtimeBindings.map((item) => ({ key: e2eRuntimeBindingKey(item.value.profileId, other), value: item.value }));
      })).success).toBe(false);
    });

    it("refuses version 1 with a kind in a key, and a version no code knows", () => {
      expect(E2EApplicationExecutionAdmissionSchema.safeParse(resign((body) => {
        body.runtimeBindings = stored.runtimeBindings.map((item) => ({ key: e2eRuntimeBindingKey(item.value.profileId, kindOf(item.value)), value: item.value }));
      })).success).toBe(false);
      expect(E2EApplicationExecutionAdmissionSchema.safeParse(resign((body) => { body.schemaVersion = "workflow-e2e-application-admission/v3"; })).success).toBe(false);
    });
  });
});
