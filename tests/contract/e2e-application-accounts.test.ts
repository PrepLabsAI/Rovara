import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { E2EAppRecipeSchema } from "../../packages/contracts/src/e2e.js";
import { E2EApplicationRuntimeRefSchema } from "../../packages/contracts/src/e2e-application.js";
import type { E2ESourceSnapshot } from "../../packages/contracts/src/e2e-source.js";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow.js";
import type { z } from "zod";
import { inspectE2ERepository } from "../../packages/contracts/src/e2e-catalog.js";
import {
  E2EApplicationAccountDefinitionSchema,
  E2EApplicationProjectContractSchema,
  deriveE2EApplicationRuntimeAccountRef,
  bindE2EApplicationAccountTargets,
  e2eApplicationAccountDefinitionDigest,
  e2eApplicationAccountTargetId,
  readE2EApplicationProjectContract,
  validateE2EApplicationAccountBinding,
} from "../../packages/contracts/src/e2e-application-accounts.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type ProjectSource = { agentx: { e2e: z.infer<typeof E2EApplicationProjectContractSchema> } };
const sourceProject = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()) as ProjectSource;
function recipeBody() {
  return {
    schemaVersion: 1 as const,
    build: [],
    launch: { kind: "service" as const, start: { program: "node", args: ["server.mjs"], cwd: ".", timeoutMs: 30_000, env: {} }, health: { path: "/health", expectedStatus: 200 } },
    serviceProfileIds: ["local-http"], seedProfileId: "orders-seed/v1",
    accountProfileIds: ["synthetic", "orders-owner", "orders-viewer"],
    allowedOrigins: ["orders-api"],
  };
}
function recipe() {
  const body = recipeBody();
  return E2EAppRecipeSchema.parse({ ...body, recipeDigest: sha(canonicalJson(body)) });
}
function sourceSnapshot(project: unknown = { schemaVersion: "e2e-application-project/v1", recipe: recipe(),
  service: { listenPort: 4317, portEnv: "APP_PORT", originBindings: [{ originRef: "orders-api", envName: "ORDERS_API_ORIGIN" }] },
  accountProfiles: [
    { profileId: "synthetic", scope: "synthetic-test", authProfileId: "orders-auth/v1", seedProfileId: "orders-seed/v1", tenantRef: "tenant-a", roleRef: "viewer", identityProbeId: "orders-identity/v1" },
    { profileId: "orders-owner", scope: "synthetic-test", authProfileId: "orders-auth/v1", seedProfileId: "orders-seed/v1", tenantRef: "tenant-a", roleRef: "owner", identityProbeId: "orders-identity/v1" },
    { profileId: "orders-viewer", scope: "synthetic-test", authProfileId: "orders-auth/v1", seedProfileId: "orders-seed/v1", tenantRef: "tenant-a", roleRef: "viewer", identityProbeId: "orders-identity/v1" },
  ], targetAccounts: [{ baseTargetId: "target-orders-web", profileId: "orders-owner" }, { baseTargetId: "target-orders-api", profileId: "orders-viewer" }],
}) {
  const bytes = Buffer.from(JSON.stringify(project === null ? { name: "orders-app" } : { name: "orders-app", agentx: { e2e: project } }));
  const commitSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const candidate = createCandidateManifest([{ repositoryId: "repo", commitSha, treeSha }]);
  const path = "apps/orders/package.json";
  return {
    snapshot: { candidate, commitSha, treeSha, treeComplete: true, treePaths: [path], sources: [{ path, sha256: sha(bytes.toString("utf8")), bytes, kind: "blob" }] } as E2ESourceSnapshot,
    candidate,
  };
}

describe("source-owned application account contracts", () => {
  it("reads only the owning package manifest and preserves the declared account semantics", () => {
    const { snapshot } = sourceSnapshot();
    const contract = readE2EApplicationProjectContract(snapshot, "orders-app");
    expect(contract?.accountProfiles.map(({ profileId, roleRef }) => [profileId, roleRef])).toEqual([
      ["synthetic", "viewer"], ["orders-owner", "owner"], ["orders-viewer", "viewer"],
    ]);
  });

  it("keeps absence distinct from malformed, foreign, or over-bounded metadata", () => {
    const absent = sourceSnapshot(null);
    expect(readE2EApplicationProjectContract(absent.snapshot, "orders-app")).toBeNull();
    const malformed = sourceSnapshot({ schemaVersion: "e2e-application-project/v1", unexpected: true });
    expect(() => readE2EApplicationProjectContract(malformed.snapshot, "orders-app")).toThrow();
    const foreign = sourceSnapshot();
    expect(() => readE2EApplicationProjectContract(foreign.snapshot, "apps/elsewhere")).toThrow();
  });

  it("uses a stable variant identity derived from both the approved base target and profile", () => {
    const owner = e2eApplicationAccountTargetId("target-orders-web", "orders-owner");
    expect(owner).toMatch(/^account-target-[a-f0-9]{64}$/);
    expect(owner).toBe(e2eApplicationAccountTargetId("target-orders-web", "orders-owner"));
    expect(owner).not.toBe(e2eApplicationAccountTargetId("target-orders-api", "orders-owner"));
  });

  it("copies exact base target identity for variants and retains the default synthetic target unchanged", () => {
    const { snapshot } = sourceSnapshot();
    const project = sourceProject(snapshot.sources[0]!.bytes).agentx.e2e;
    const contract = E2EApplicationProjectContractSchema.parse(project);
    const base = { targetId: "target-orders-web", applicationId: "orders-app", runtimeProfileId: "web-chromium/v1", accountProfileId: "synthetic", kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 720 } };
    const apiBase = { targetId: "target-orders-api", applicationId: "orders-app", runtimeProfileId: "api-http/v1", accountProfileId: "synthetic", kind: "api" as const, protocol: "http" as const, originRef: "orders-api" };
    const targets = bindE2EApplicationAccountTargets({ contract, applicationId: "orders-app", baseTargets: [base, apiBase] });
    expect(targets[0]).toBe(base);
    expect(targets.find((target) => target.targetId === e2eApplicationAccountTargetId(base.targetId, "orders-owner"))).toEqual({ ...base, targetId: e2eApplicationAccountTargetId(base.targetId, "orders-owner"), accountProfileId: "orders-owner" });
    expect(targets.find((target) => target.targetId === e2eApplicationAccountTargetId(apiBase.targetId, "orders-viewer"))).toEqual({ ...apiBase, targetId: e2eApplicationAccountTargetId(apiBase.targetId, "orders-viewer"), accountProfileId: "orders-viewer" });
    expect(() => bindE2EApplicationAccountTargets({ contract, applicationId: "another-app", baseTargets: [base] })).toThrow();
  });

  it("validates strict protected account definitions and binds their full canonical digest", () => {
    const contract = sourceProject(sourceSnapshot().snapshot.sources[0]!.bytes).agentx.e2e;
    const definition = E2EApplicationAccountDefinitionSchema.parse({
      schemaVersion: "e2e-application-account-definition/v1", applicationId: "orders-app", profileId: "orders-owner", revision: 4,
      contractDigest: sha(canonicalJson(contract)), authProfileId: "orders-auth/v1", seedProfileId: "orders-seed/v1",
      subjectIdDigest: sha("orders-owner"), tenantIdDigest: sha(canonicalJson("tenant-a")), roleRef: "owner", credentialHandleId: "credential/orders-owner",
      connectionRef: null, expiresAt: "2027-01-01T00:00:00.000Z",
    });
    const expectedRef = deriveE2EApplicationRuntimeAccountRef(definition);
    expect(E2EApplicationRuntimeRefSchema.shape.accountProfileId).toBeDefined();
    expect(e2eApplicationAccountDefinitionDigest(definition)).toBe(sha(canonicalJson(definition)));
    expect(validateE2EApplicationAccountBinding({ contract, definition, expectedRef, now: "2026-10-17T12:00:00.000Z" })).toEqual(expectedRef);
    expect(() => validateE2EApplicationAccountBinding({ contract, definition: { ...definition, revision: 5 }, expectedRef, now: "2026-10-17T12:00:00.000Z" })).toThrow();
    expect(() => validateE2EApplicationAccountBinding({ contract, definition, expectedRef, now: "2027-01-01T00:00:00.000Z" })).toThrow();
    expect(() => E2EApplicationAccountDefinitionSchema.parse({ ...definition, password: "must-never-be-stored" })).toThrow();
  });

  it("requires a matching approved named connection for external-test identities", () => {
    const project = sourceSnapshot();
    const root = sourceProject(project.snapshot.sources[0]!.bytes);
    const external = {
      ...root.agentx.e2e,
      recipe: (() => { const body = { ...recipeBody(), accountProfileIds: ["synthetic", "orders-owner", "orders-viewer", "partner-a"] }; return E2EAppRecipeSchema.parse({ ...body, recipeDigest: sha(canonicalJson(body)) }); })(),
      accountProfiles: [...root.agentx.e2e.accountProfiles, { profileId: "partner-a", scope: "external-test", authProfileId: "partner-auth/v1", seedProfileId: "orders-seed/v1", tenantRef: "partner-tenant", roleRef: "viewer", identityProbeId: "partner-identity/v1" }],
    };
    const contract = E2EApplicationProjectContractSchema.parse(external);
    const definition = { schemaVersion: "e2e-application-account-definition/v1", applicationId: "orders-app", profileId: "partner-a", revision: 1,
      contractDigest: sha(canonicalJson(contract)), authProfileId: "partner-auth/v1", seedProfileId: "partner-seed/v1", subjectIdDigest: sha("partner-user"),
      tenantIdDigest: sha("partner-tenant"), roleRef: "viewer", credentialHandleId: "credential/partner-a", connectionRef: null, expiresAt: "2027-01-01T00:00:00.000Z" };
    const parsed = E2EApplicationAccountDefinitionSchema.parse(definition);
    expect(() => validateE2EApplicationAccountBinding({ contract, definition: parsed, expectedRef: deriveE2EApplicationRuntimeAccountRef(parsed), now: "2026-10-17T12:00:00.000Z" })).toThrow();
  });

  it("discovers explicit project contracts as source-bound recipe and account variants while preserving absence behavior", () => {
    const base = sourceSnapshot();
    const value = sourceProject(base.snapshot.sources[0]!.bytes);
    value.agentx.e2e.targetAccounts = [{ baseTargetId: "web-1", profileId: "orders-owner" }, { baseTargetId: "web-1", profileId: "orders-viewer" }];
    const bytes = Buffer.from(JSON.stringify(value));
    const snapshot = { ...base.snapshot, sources: [{ ...base.snapshot.sources[0]!, bytes, sha256: sha(bytes.toString("utf8")) }] };
    const found = inspectE2ERepository(snapshot, base.candidate).inspection;
    const app = found.applications.find((item) => item.applicationId === "orders-app");
    expect(app?.recipe).toEqual(value.agentx.e2e.recipe);
    expect(app?.sourcePaths).toContain("apps/orders/package.json");
    expect(found.proposedTargets.filter((target) => target.applicationId === "orders-app").map((target) => target.accountProfileId).sort())
      .toEqual(["orders-owner", "orders-viewer", "synthetic"]);

    const absent = sourceSnapshot(null);
    const legacy = inspectE2ERepository(absent.snapshot, absent.candidate).inspection;
    expect(legacy.applications[0]?.recipe).toBeNull();
    expect(legacy.proposedTargets[0]?.accountProfileId).toBe("synthetic");
  });

  describe("reader and catalog agree on which package manifests exist", () => {
    const contractSnapshot = (extra: Array<{ path: string; bytes: Buffer }>) => {
      const base = sourceSnapshot();
      const project = sourceProject(base.snapshot.sources[0]!.bytes);
      project.agentx.e2e.targetAccounts = [{ baseTargetId: "web-1", profileId: "orders-owner" }];
      const files = [{ path: base.snapshot.sources[0]!.path, bytes: Buffer.from(JSON.stringify(project)) }, ...extra];
      const sources = files.map((file) => ({ path: file.path, sha256: sha(file.bytes.toString("utf8")), bytes: file.bytes, kind: "blob" as const }));
      // Lossy-decoded bytes hash differently from their utf8 text, so hash the raw bytes as the snapshot verifier does.
      for (const source of sources) source.sha256 = createHash("sha256").update(source.bytes).digest("hex");
      return { candidate: base.candidate, snapshot: { ...base.snapshot, treePaths: sources.map((source) => source.path), sources } as E2ESourceSnapshot };
    };
    const orders = JSON.stringify({ name: "orders-app" });
    const expectContractRecipe = (extra: Array<{ path: string; bytes: Buffer }>) => {
      const { snapshot, candidate } = contractSnapshot(extra);
      const inspection = inspectE2ERepository(snapshot, candidate).inspection;
      expect(inspection.missingInputs.filter((input) => input.inputId.startsWith("application-project-contract-"))).toEqual([]);
      expect(inspection.applications.find((app) => app.sourcePaths.includes("apps/orders/package.json"))?.recipe).toEqual(recipe());
    };

    it("ignores a same-named file that only ends in package.json", () => {
      expectContractRecipe([{ path: "docs/old-package.json", bytes: Buffer.from(orders) }]);
    });

    it("counts a same-named manifest the same way the catalog decodes it", () => {
      expectContractRecipe([{ path: "apps/zz-legacy/package.json", bytes: Buffer.concat([Buffer.from('{"name":"orders-app","description":"'), Buffer.from([0xff]), Buffer.from('"}')]) }]);
    });
  });

  describe("mainline discovery for packages outside the source project contract", () => {
    const snapshotOf = (pkg: unknown) => {
      const bytes = Buffer.from(JSON.stringify(pkg));
      const commitSha = "c".repeat(40); const treeSha = "d".repeat(40);
      const candidate = createCandidateManifest([{ repositoryId: "repo", commitSha, treeSha }]);
      return { candidate, snapshot: { candidate, commitSha, treeSha, treeComplete: true, treePaths: ["package.json"],
        sources: [{ path: "package.json", sha256: sha(bytes.toString("utf8")), bytes, kind: "blob" }] } as E2ESourceSnapshot };
    };
    const unnamedApi = { scripts: { start: "node s.js" }, dependencies: { express: "1" } };
    const expectMainlineRecipe = (pkg: unknown) => {
      const { snapshot, candidate } = snapshotOf(pkg);
      const inspection = inspectE2ERepository(snapshot, candidate).inspection;
      expect(inspection.applications).toHaveLength(1);
      expect(inspection.applications[0]?.recipe).not.toBeNull();
      expect(inspection.missingInputs.some((input) => input.inputId.startsWith("application-project-contract-"))).toBe(false);
    };

    it("keeps an unnamed web/API package on the synthesized start recipe", () => expectMainlineRecipe(unnamedApi));
    it("keeps a package with an invalid name on the synthesized start recipe", () => expectMainlineRecipe({ ...unnamedApi, name: "bad name!" }));

    it("applies no project contract recipe to a mobile package", () => {
      const contractProject = { schemaVersion: "e2e-application-project/v1", recipe: recipe(), service: null,
        accountProfiles: [{ profileId: "synthetic", scope: "synthetic-test", authProfileId: "a/v1", seedProfileId: "orders-seed/v1", tenantRef: "t", roleRef: "viewer", identityProbeId: "i/v1" }],
        targetAccounts: [] };
      const { snapshot, candidate } = snapshotOf({ name: "mobile-app", dependencies: { "react-native": "1" }, agentx: { e2e: contractProject } });
      const inspection = inspectE2ERepository(snapshot, candidate).inspection;
      expect(inspection.applications).toHaveLength(1);
      expect(inspection.applications[0]?.recipe).toBeNull();
      expect(inspection.missingInputs.some((input) => input.inputId.startsWith("application-project-contract-"))).toBe(false);
    });
  });
});
