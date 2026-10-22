import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { E2EAppRecipeSchema } from "../../packages/contracts/src/e2e.js";
import { E2EApplicationRuntimeRefSchema } from "../../packages/contracts/src/e2e-application.js";
import type { E2ESourceSnapshot } from "../../packages/contracts/src/e2e-source.js";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow.js";
import type { z } from "zod";
import { e2eApplicationRecipeOrigin, inspectE2EApplicationRepository, inspectE2ERepository, withE2EAnonymousTargets } from "../../packages/contracts/src/e2e-catalog.js";
import {
  E2EApplicationAccountDefinitionSchema,
  E2EApplicationProjectContractSchema,
  deriveE2EApplicationRuntimeAccountRef,
  bindE2EApplicationAccountTargets,
  e2eAnonymousVariantOf,
  E2E_ANONYMOUS_ACCOUNT_PROFILE_ID,
  e2eAnonymousRuntimeAccountRef,
  e2eApplicationAccountDefinitionDigest,
  e2eApplicationAccountTargetId,
  e2eSyntheticAccountContractDigest,
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
      // A synthetic account binds to its own slice of the contract (Task 3.1), so another profile changing does not move it; an external-test one to the whole contract.
      contractDigest: e2eSyntheticAccountContractDigest(E2EApplicationProjectContractSchema.parse(contract), "orders-owner"), authProfileId: "orders-auth/v1", seedProfileId: "orders-seed/v1",
      subjectIdDigest: sha("orders-owner"), tenantIdDigest: sha(canonicalJson("tenant-a")), roleRef: "owner", credentialHandleId: "credential/orders-owner",
      connectionRef: null, expiresAt: "2027-01-01T00:00:00.000Z",
    });
    const expectedRef = deriveE2EApplicationRuntimeAccountRef(definition);
    expect(E2EApplicationRuntimeRefSchema.shape.accountProfileId).toBeDefined();
    expect(e2eApplicationAccountDefinitionDigest(definition)).toBe(sha(canonicalJson(definition)));
    expect(validateE2EApplicationAccountBinding({ contract, definition, expectedRef, now: "2026-10-17T12:00:00.000Z" })).toEqual(expectedRef);
    expect(() => validateE2EApplicationAccountBinding({ contract, definition: { ...definition, revision: 5 }, expectedRef, now: "2026-10-17T12:00:00.000Z" })).toThrow();
    expect(() => validateE2EApplicationAccountBinding({ contract, definition, expectedRef, now: "2027-01-01T00:00:00.000Z" })).toThrow();
    const wholeContract = { ...definition, contractDigest: sha(canonicalJson(contract)) };
    expect(() => validateE2EApplicationAccountBinding({ contract, definition: wholeContract, expectedRef: deriveE2EApplicationRuntimeAccountRef(wholeContract), now: "2026-10-17T12:00:00.000Z" })).toThrow();
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

describe("the reserved anonymous account profile (Ruling AZ)", () => {
  const application = "orders-app";
  const projectWith = (edit: (project: ProjectSource["agentx"]["e2e"]) => void) => {
    const project = structuredClone(sourceProject(sourceSnapshot().snapshot.sources[0]!.bytes).agentx.e2e);
    edit(project);
    return project;
  };

  it("has the fixed account reference of the plan: revision 1 and a digest of the domain string and the application id, with no registry row behind it", () => {
    expect(E2E_ANONYMOUS_ACCOUNT_PROFILE_ID).toBe("rovara-anonymous");
    const ref = e2eAnonymousRuntimeAccountRef(application);
    expect(ref).toEqual({ applicationId: application, profileId: "rovara-anonymous", revision: 1, definitionDigest: sha(`rovara-anonymous/v1\0${application}`) });
    expect(e2eAnonymousRuntimeAccountRef("another-app").definitionDigest).not.toBe(ref.definitionDigest);
  });

  it("is refused when a contract declares it, in the account inventory, the recipe's list or a target variant, with the reserved-account-profile reason", () => {
    const declared = projectWith((project) => {
      project.accountProfiles.push({ ...project.accountProfiles[0]!, profileId: "rovara-anonymous" });
      project.recipe = { ...project.recipe, accountProfileIds: [...project.recipe.accountProfileIds, "rovara-anonymous"] };
    });
    expect(() => E2EApplicationProjectContractSchema.parse(declared)).toThrow(/reserved-account-profile/);
    const variant = projectWith((project) => { project.targetAccounts.push({ baseTargetId: "target-orders-web", profileId: "rovara-anonymous" }); });
    expect(() => E2EApplicationProjectContractSchema.parse(variant)).toThrow(/reserved-account-profile/);
    const listed = projectWith((project) => { project.recipe = { ...project.recipe, accountProfileIds: [...project.recipe.accountProfileIds, "rovara-anonymous"] }; });
    expect(() => E2EApplicationProjectContractSchema.parse(listed)).toThrow(/reserved-account-profile/);
    expect(() => E2EApplicationProjectContractSchema.parse(projectWith(() => undefined))).not.toThrow();
  });

  const baseWeb = { targetId: "web-1", applicationId: application, runtimeProfileId: "linux-arm64-web-api-v1", accountProfileId: "synthetic", kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 720 } };
  const baseApi = { targetId: "api-2", applicationId: application, runtimeProfileId: "linux-arm64-web-api-v1", accountProfileId: "synthetic", kind: "api" as const, protocol: "http" as const, originRef: "app-origin" };
  const inferredSnapshot = (scripts: Record<string, string>, withLock = true) => {
    const manifest = Buffer.from(JSON.stringify({ name: "shop-web", scripts }));
    const commitSha = "c".repeat(40); const treeSha = "d".repeat(40);
    const candidate = createCandidateManifest([{ repositoryId: "repo", commitSha, treeSha }]);
    const sources = [{ path: "package.json", sha256: sha(manifest.toString("utf8")), bytes: manifest, kind: "blob" as const },
      ...(withLock ? [{ path: "package-lock.json", sha256: sha("{}"), bytes: Buffer.from("{}"), kind: "blob" as const }] : [])];
    return { candidate, snapshot: { candidate, commitSha, treeSha, treeComplete: true, treePaths: sources.map((item) => item.path).sort(), sources } as E2ESourceSnapshot };
  };

  it("derives the implicit variant of a base web or API target, copied from the base, and of nothing else", () => {
    expect(e2eAnonymousVariantOf(baseWeb)).toEqual({ ...baseWeb, targetId: "web-1-anonymous", accountProfileId: "rovara-anonymous" });
    expect(e2eAnonymousVariantOf(baseApi)).toEqual({ ...baseApi, targetId: "api-2-anonymous", accountProfileId: "rovara-anonymous" });
    const desktop = { targetId: "desktop-3", applicationId: application, runtimeProfileId: "electron-phase-unavailable", accountProfileId: "synthetic", kind: "desktop" as const, os: "linux" as const, driver: "electron" as const, appId: application };
    expect(() => e2eAnonymousVariantOf(desktop)).toThrow();
    expect(() => e2eAnonymousVariantOf(e2eAnonymousVariantOf(baseWeb))).toThrow();
  });

  it("keeps the variants out of discovery and out of a setup proposal, and derives them on the application path from the base targets (F1)", () => {
    const { snapshot, candidate } = inferredSnapshot({ start: "node server.js" });
    // Discovery as the setup reads it is what it always was: the base target alone.
    expect(inspectE2ERepository(snapshot, candidate).inspection.proposedTargets.map((target) => [target.targetId, target.accountProfileId])).toEqual([["web-1", "synthetic"]]);
    const read = inspectE2EApplicationRepository(snapshot, candidate);
    expect(read.inspection.proposedTargets.map((target) => [target.targetId, target.accountProfileId])).toEqual([["web-1", "synthetic"], ["web-1-anonymous", "rovara-anonymous"]]);
    expect(read.anonymous).toEqual({ variants: [{ baseTargetId: "web-1", targetId: "web-1-anonymous" }], omittedBaseTargetIds: [] });
    // A policy or proposal that holds the base gets the variant, on the base's own runtime profile; one that has it already, or holds no such base, gets nothing added.
    const stored = [{ ...baseWeb, applicationId: read.inspection.applications[0]!.applicationId }];
    const derived = withE2EAnonymousTargets(stored, read.anonymous);
    expect(derived).toEqual([stored[0], { ...stored[0], targetId: "web-1-anonymous", accountProfileId: "rovara-anonymous" }]);
    expect(withE2EAnonymousTargets(derived, read.anonymous)).toEqual(derived);
    expect(withE2EAnonymousTargets([], read.anonymous)).toEqual([]);
  });

  it("offers the variant to an app with a project contract and to one with the inferred recipe, and not to one with only the start-script fallback or with no recipe (F2)", () => {
    const inferred = inferredSnapshot({ start: "node server.js" });
    expect(inspectE2EApplicationRepository(inferred.snapshot, inferred.candidate).anonymous.variants).toHaveLength(1);
    // The same package without a lockfile has no `npm ci` to infer: it falls back to `npm run start`, which builds nothing.
    const fallback = inferredSnapshot({ start: "node server.js" }, false);
    expect(inspectE2ERepository(fallback.snapshot, fallback.candidate).inspection.applications[0]?.recipe).not.toBeNull();
    expect(inspectE2EApplicationRepository(fallback.snapshot, fallback.candidate).anonymous).toEqual({ variants: [], omittedBaseTargetIds: [] });
    expect(inspectE2EApplicationRepository(fallback.snapshot, fallback.candidate).inspection.proposedTargets.map((target) => target.accountProfileId)).toEqual(["synthetic"]);
    // The Docker host runs a contract-less app only on the inferred recipe, and asks where a recipe came from.
    const appId = inspectE2ERepository(inferred.snapshot, inferred.candidate).inspection.applications[0]!.applicationId;
    expect(e2eApplicationRecipeOrigin(inferred.snapshot, appId)).toBe("inferred-node");
    expect(e2eApplicationRecipeOrigin(fallback.snapshot, appId)).toBe("start-script");
    expect(e2eApplicationRecipeOrigin(inferred.snapshot, "another-app")).toBeNull();
    const bare = sourceSnapshot(null);
    expect(inspectE2EApplicationRepository(bare.snapshot, bare.candidate).anonymous.variants).toEqual([]);
    const declared = sourceProject(sourceSnapshot().snapshot.sources[0]!.bytes).agentx.e2e;
    const contract = sourceSnapshot({ ...declared, targetAccounts: [{ baseTargetId: "web-1", profileId: "orders-owner" }] });
    const found = inspectE2EApplicationRepository(contract.snapshot, contract.candidate);
    // The base target and its owner variant, plus the visitor of the base alone (an account variant has none of its own).
    expect(found.anonymous.variants.map((item) => item.baseTargetId)).toEqual(["web-1"]);
    expect(found.inspection.proposedTargets.map((target) => target.accountProfileId).sort()).toEqual(["orders-owner", "rovara-anonymous", "synthetic"]);
  });

  it("drops the variants the 12-target inventory has no room for, and says which (F7)", () => {
    // One base target and eleven account variants of a contract fill the inventory.
    const base = sourceProject(sourceSnapshot().snapshot.sources[0]!.bytes).agentx.e2e;
    const extra = Array.from({ length: 11 }, (_, index) => `account-${index + 1}`);
    const profile = base.accountProfiles[0]!;
    const full = { ...base, recipe: (() => { const body = { ...recipeBody(), accountProfileIds: extra }; return E2EAppRecipeSchema.parse({ ...body, recipeDigest: sha(canonicalJson(body)) }); })(),
      accountProfiles: extra.map((profileId) => ({ ...profile, profileId })), targetAccounts: extra.map((profileId) => ({ baseTargetId: "web-1", profileId })) };
    const { snapshot, candidate } = sourceSnapshot(full);
    expect(inspectE2ERepository(snapshot, candidate).inspection.proposedTargets).toHaveLength(12);
    expect(inspectE2EApplicationRepository(snapshot, candidate).anonymous).toEqual({ variants: [], omittedBaseTargetIds: ["web-1"] });
    expect(inspectE2EApplicationRepository(snapshot, candidate).inspection.proposedTargets).toHaveLength(12);
  });
});
