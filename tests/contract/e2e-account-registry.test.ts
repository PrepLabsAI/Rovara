import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  E2EApplicationAccountDefinitionSchema, E2EApplicationPlanIntentSchema, E2EApplicationSelectionRecordSchema, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX,
  canonicalJson, createE2ESyntheticAccountDefinition, deriveE2EApplicationRuntimeAccountRef, deriveE2ESyntheticRuntimeAccountRef, e2eApplicationAccountDefinitionDigest,
  e2eSyntheticAccountContractDigest, resolveE2ELatestAccountRef, workflowApplicationRetryOffered, WorkflowSnapshotSchema,
} from "@agentx/contracts";
import {
  E2EAccountRegistryError, e2eAccountDefinitionKey, e2eAccountLatestKey, latestAccountRef, parseAccountEntry, pickAccountEntry, planSyntheticAccountWrites,
  type E2EAccountRegistryEntry,
} from "../../packages/broker/src/e2e/application-account-registry.js";
import { readAccountRegistryEntries } from "../../packages/broker/src/aws/e2e-account-registry.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { taskPageStage } from "../../packages/broker/src/aws/developer-tasks.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { prepareApplicationRound, startApplicationRound, type RoundBrokerHarness } from "../support/e2e-application-round-harness.js";
import { createE2EApplicationCollectionOracleFromCompiledSuite } from "@agentx/verifier";
import type { ObservedApiOutcome } from "../support/e2e-application-evidence-fixture.js";
import { NOW, binding, planFixture, snapshotOf, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { ORDERS_APPLICATION_ID, contractOf, ordersManifestWith, registryFor, sha256Hex, withOwnerB, withViewerRole } from "../support/e2e-account-registry-fixtures.js";

// Task 3.1 (owner decision D5): synthetic account definitions are written automatically when a setup is approved, versioned per (application, profile), and expire
// after 90 days. The recipe-derived stand-in of M1.2 (Ruling AT) is read only for M1.2 records; a new APPROVE never accepts it.

afterEach(disposeRealCandidates);

const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const DAY = 86_400_000;
const four = contractOf(ordersManifestWith(withOwnerB));
const fourWritten = () => planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: [], now: T0 });
const entriesOf = (writes: ReturnType<typeof fourWritten>): E2EAccountRegistryEntry[] => writes.map((write) => ({ definition: write.definition, latest: write.latest }));

describe("a synthetic account definition", () => {
  it("carries the values the registry writes, and the binding check accepts it for the approved contract", () => {
    const definition = createE2ESyntheticAccountDefinition({ contract: four, applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer", revision: 1, now: T0 });
    expect(definition).toEqual({
      schemaVersion: "e2e-application-account-definition/v1", applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer", revision: 1,
      contractDigest: e2eSyntheticAccountContractDigest(four, "orders-viewer"), authProfileId: "orders-auth/v1", seedProfileId: "orders-seed/v1",
      subjectIdDigest: createHash("sha256").update(`rovara-synthetic-subject/v1\0${ORDERS_APPLICATION_ID}\0orders-viewer`).digest("hex"),
      tenantIdDigest: sha256Hex(canonicalJson("tenant-a")), roleRef: "viewer", credentialHandleId: null, connectionRef: null, expiresAt: "2027-01-18T00:00:00.000Z",
    });
    expect(E2EApplicationAccountDefinitionSchema.parse(definition)).toEqual(definition);
    const ref = resolveE2ELatestAccountRef({ contract: four, definition, latest: { revision: 1, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) }, now: T0 });
    expect(ref).toEqual(deriveE2EApplicationRuntimeAccountRef(definition));
  });

  it("gives a profile in another tenant another tenant digest and another subject digest", () => {
    const owner = createE2ESyntheticAccountDefinition({ contract: four, applicationId: ORDERS_APPLICATION_ID, profileId: "orders-owner", revision: 1, now: T0 });
    const ownerB = createE2ESyntheticAccountDefinition({ contract: four, applicationId: ORDERS_APPLICATION_ID, profileId: "orders-owner-b", revision: 1, now: T0 });
    expect(owner.tenantIdDigest).not.toBe(ownerB.tenantIdDigest);
    expect(ownerB.tenantIdDigest).toBe(sha256Hex(canonicalJson("tenant-b")));
    expect(owner.subjectIdDigest).not.toBe(ownerB.subjectIdDigest);
  });

  it("refuses to define an account the approved contract does not declare as synthetic", () => {
    expect(() => createE2ESyntheticAccountDefinition({ contract: four, applicationId: ORDERS_APPLICATION_ID, profileId: "nobody", revision: 1, now: T0 })).toThrow();
  });

  it("is refused when its tenant digest is not the contract's, even when the latest pointer carries the tampered digest (registry tampering)", () => {
    const honest = createE2ESyntheticAccountDefinition({ contract: four, applicationId: ORDERS_APPLICATION_ID, profileId: "orders-owner-b", revision: 1, now: T0 });
    const tampered = { ...honest, tenantIdDigest: sha256Hex(canonicalJson("tenant-a")) };
    const latest = { revision: 1, definitionDigest: e2eApplicationAccountDefinitionDigest(tampered) };
    expect(() => resolveE2ELatestAccountRef({ contract: four, definition: tampered, latest, now: T0 })).toThrow(/does not match the current source contract/);
    expect(() => latestAccountRef({ contract: four, entries: [{ definition: tampered, latest }], applicationId: ORDERS_APPLICATION_ID, profileId: "orders-owner-b", now: T0 }))
      .toThrow(/accounts-changed-reapprove/);
  });

  it("is refused when its role is not the contract's, when it is expired, and when the latest pointer is not its own digest", () => {
    const owner = createE2ESyntheticAccountDefinition({ contract: four, applicationId: ORDERS_APPLICATION_ID, profileId: "orders-owner", revision: 1, now: T0 });
    const latestOf = (definition: typeof owner) => ({ revision: definition.revision, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) });
    const escalated = { ...owner, roleRef: "admin" };
    expect(() => resolveE2ELatestAccountRef({ contract: four, definition: escalated, latest: latestOf(escalated), now: T0 })).toThrow();
    expect(() => resolveE2ELatestAccountRef({ contract: four, definition: owner, latest: latestOf(owner), now: T0 + 90 * DAY })).toThrow();
    expect(() => resolveE2ELatestAccountRef({ contract: four, definition: owner, latest: latestOf(owner), now: T0 + 90 * DAY - 1 })).not.toThrow();
    expect(() => resolveE2ELatestAccountRef({ contract: four, definition: owner, latest: { revision: 2, definitionDigest: latestOf(owner).definitionDigest }, now: T0 })).toThrow(/latest/);
    expect(() => resolveE2ELatestAccountRef({ contract: four, definition: owner, latest: { revision: 1, definitionDigest: "0".repeat(64) }, now: T0 })).toThrow(/latest/);
  });

  it("binds its contract digest to its own profile and the launch recipe, so another profile's change leaves it as it was", () => {
    const viewerRoleChanged = contractOf(ordersManifestWith((e2e) => { withOwnerB(e2e); withViewerRole("auditor")(e2e); }));
    expect(e2eSyntheticAccountContractDigest(viewerRoleChanged, "orders-owner")).toBe(e2eSyntheticAccountContractDigest(four, "orders-owner"));
    expect(e2eSyntheticAccountContractDigest(viewerRoleChanged, "orders-viewer")).not.toBe(e2eSyntheticAccountContractDigest(four, "orders-viewer"));
    const relaunched = contractOf(ordersManifestWith((e2e) => { withOwnerB(e2e); (e2e.recipe as unknown as { launch: { start: { args: string[] } } }).launch.start.args = ["other.mjs"]; }));
    expect(e2eSyntheticAccountContractDigest(relaunched, "orders-owner")).not.toBe(e2eSyntheticAccountContractDigest(four, "orders-owner"));
  });
});

describe("what a registration writes", () => {
  it("writes revision 1 of each of the four synthetic profiles of the fixture contract", () => {
    const writes = fourWritten();
    expect(writes.map((write) => write.definition.profileId).sort()).toEqual(["orders-owner", "orders-owner-b", "orders-viewer", "synthetic"]);
    for (const write of writes) {
      expect(write.definition.revision).toBe(1);
      expect(write.previousRevision).toBeNull();
      expect(write.latest).toEqual({ revision: 1, definitionDigest: e2eApplicationAccountDefinitionDigest(write.definition) });
    }
  });

  it("writes nothing when the same contract is approved again, even on a later day", () => {
    expect(planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: entriesOf(fourWritten()), now: T0 + 30 * DAY })).toEqual([]);
  });

  it("writes revision 2 for orders-viewer only when its roleRef changes", () => {
    const changed = contractOf(ordersManifestWith((e2e) => { withOwnerB(e2e); withViewerRole("auditor")(e2e); }));
    const writes = planSyntheticAccountWrites({ contract: changed, applicationId: ORDERS_APPLICATION_ID, prior: entriesOf(fourWritten()), now: T0 + DAY });
    expect(writes.map((write) => [write.definition.profileId, write.definition.revision, write.previousRevision])).toEqual([["orders-viewer", 2, 1]]);
    expect(writes[0]!.definition.roleRef).toBe("auditor");
    expect(writes[0]!.latest.revision).toBe(2);
  });

  it("writes a new revision of a profile whose definition has expired, with a fresh expiry, and of no other", () => {
    const writes = planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: entriesOf(fourWritten()), now: T0 + 91 * DAY });
    expect(writes).toHaveLength(4);
    for (const write of writes) {
      expect(write.definition.revision).toBe(2);
      expect(write.definition.expiresAt).toBe(new Date(T0 + 181 * DAY).toISOString());
    }
    const oneExpired = entriesOf(fourWritten()).map((entry) => (entry.definition.profileId === "orders-owner"
      ? { ...entry, definition: { ...entry.definition, expiresAt: new Date(T0 - 1).toISOString() } } : entry));
    // The expired definition no longer matches its latest pointer, so it is written again; the others are left alone.
    const rewritten = planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: oneExpired, now: T0 });
    expect(rewritten.map((write) => write.definition.profileId)).toEqual(["orders-owner"]);
  });

  it("writes nothing for an external-test profile: its definition needs a credential handle and a connection that this registry never invents", () => {
    const withExternal = contractOf(ordersManifestWith((e2e) => {
      e2e.accountProfiles.push({ profileId: "partner-a", scope: "external-test", authProfileId: "partner-auth/v1", seedProfileId: "orders-seed/v1", tenantRef: "partner",
        roleRef: "viewer", identityProbeId: "partner-identity/v1" });
      e2e.recipe.accountProfileIds.push("partner-a");
    }));
    const writes = planSyntheticAccountWrites({ contract: withExternal, applicationId: ORDERS_APPLICATION_ID, prior: [], now: T0 });
    expect(writes.map((write) => write.definition.profileId).sort()).toEqual(["orders-owner", "orders-viewer", "synthetic"]);
  });

  it("renews a definition with fourteen days or fewer left, and leaves one with more alone (day 75, day 89, day 91)", () => {
    const written = entriesOf(fourWritten());
    const plan = (days: number) => planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: written, now: T0 + days * DAY });
    expect(plan(75)).toEqual([]);
    expect(plan(76).map((write) => write.definition.revision)).toEqual([2, 2, 2, 2]);
    expect(plan(89)).toHaveLength(4);
    expect(plan(89)[0]!.definition.expiresAt).toBe(new Date(T0 + 179 * DAY).toISOString());
    expect(plan(91)).toHaveLength(4);
  });

  it("refuses a change from a setup approved earlier than the one that wrote the account, and still renews the same definition from it", () => {
    const newer = (profile: string) => planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: [], now: T0, setup: { approvedAt: "2026-10-02T00:00:00.000Z" } })
      .find((write) => write.definition.profileId === profile)!;
    const prior = ["orders-viewer", "orders-owner"].map((profile) => ({ definition: newer(profile).definition, latest: newer(profile).latest, setupApprovedAt: "2026-10-02T00:00:00.000Z" }));
    const changed = contractOf(ordersManifestWith((e2e) => { withOwnerB(e2e); withViewerRole("auditor")(e2e); }));
    expect(() => planSyntheticAccountWrites({ contract: changed, applicationId: ORDERS_APPLICATION_ID, prior, now: T0, setup: { approvedAt: "2026-10-01T00:00:00.000Z" } }))
      .toThrow(/newer approved setup.*orders-viewer.*roll the account back/s);
    // The same definition from the older setup is a renewal, not a rollback; and a newer setup writes.
    const renewed = planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior, now: T0 + 80 * DAY, setup: { approvedAt: "2026-10-01T00:00:00.000Z" } })
      .filter((write) => write.previousRevision !== null);
    expect(renewed.map((write) => write.definition.profileId).sort()).toEqual(["orders-owner", "orders-viewer"]);
    expect(renewed.every((write) => write.definition.revision === 2 && write.setupApprovedAt === "2026-10-02T00:00:00.000Z")).toBe(true);
    expect(planSyntheticAccountWrites({ contract: changed, applicationId: ORDERS_APPLICATION_ID, prior, now: T0, setup: { approvedAt: "2026-10-03T00:00:00.000Z" } })
      .filter((write) => write.previousRevision !== null && write.touch !== true).map((write) => [write.definition.profileId, write.definition.revision])).toEqual([["orders-viewer", 2]]);
  });

  it("writes over an account whose rows cannot be read, at the revision after the highest there is", () => {
    const repaired = planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: [], now: T0,
      repairs: [{ applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer", nextRevision: 4 }] });
    const viewer = repaired.find((write) => write.definition.profileId === "orders-viewer")!;
    expect(viewer).toMatchObject({ repair: true, previousRevision: null, definition: { revision: 4 } });
    expect(repaired.filter((write) => write.definition.profileId !== "orders-viewer").every((write) => write.definition.revision === 1)).toBe(true);
  });

  it("raises the setup approval an account records when a newer setup registers it unchanged, and backfills one that records none", () => {
    const written = fourWritten().map((write) => ({ definition: write.definition, latest: write.latest, setupApprovedAt: "2026-10-01T00:00:00.000Z" }));
    const plan = (prior: readonly E2EAccountRegistryEntry[], approvedAt: string) => planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior, now: T0, setup: { approvedAt } });
    // The same setup again, or an older one: nothing to record.
    expect(plan(written, "2026-10-01T00:00:00.000Z")).toEqual([]);
    expect(plan(written, "2026-09-01T00:00:00.000Z")).toEqual([]);
    // A newer setup with the same definitions: the pointer is raised, no new definition.
    const raised = plan(written, "2026-10-03T00:00:00.000Z");
    expect(raised).toHaveLength(4);
    expect(raised.every((write) => write.touch === true && write.previousRevision === 1 && write.definition.revision === 1 && write.setupApprovedAt === "2026-10-03T00:00:00.000Z")).toBe(true);
    // A pointer that records no setup approval is the oldest: any setup backfills it.
    const unrecorded = written.map((entry) => ({ definition: entry.definition, latest: entry.latest }));
    expect(plan(unrecorded, "2026-09-01T00:00:00.000Z").every((write) => write.touch === true && write.setupApprovedAt === "2026-09-01T00:00:00.000Z")).toBe(true);
  });

  it("refuses to repair an unreadable account from a setup approved earlier than the one its pointer still names", () => {
    const repair = { applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer", nextRevision: 3, setupApprovedAt: "2026-10-02T00:00:00.000Z" };
    expect(() => planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: [], now: T0, setup: { approvedAt: "2026-10-01T00:00:00.000Z" }, repairs: [repair] }))
      .toThrow(/newer approved setup.*orders-viewer.*roll the account back/s);
    const repaired = planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: [], now: T0, setup: { approvedAt: "2026-10-03T00:00:00.000Z" }, repairs: [repair] });
    expect(repaired.find((write) => write.repair === true)?.setupApprovedAt).toBe("2026-10-03T00:00:00.000Z");
  });

  it("names an unreadable row specifically and parses the others", () => {
    const [good] = entriesOf(fourWritten());
    const goodRows = { latest: { ...e2eAccountLatestKey("payments", ORDERS_APPLICATION_ID, good!.definition.profileId), entityType: "E2E_ACCOUNT_LATEST", ...good!.latest },
      definition: { ...e2eAccountDefinitionKey("payments", ORDERS_APPLICATION_ID, good!.definition.profileId, 1), entityType: "E2E_ACCOUNT", ...good!.definition } };
    expect(parseAccountEntry("payments", ORDERS_APPLICATION_ID, good!.definition.profileId, goodRows.latest, goodRows.definition).definition).toEqual(good!.definition);
    expect(() => parseAccountEntry("payments", ORDERS_APPLICATION_ID, good!.definition.profileId, { ...goodRows.latest, revision: "garbage" }, goodRows.definition))
      .toThrow(new RegExp(`account profile ${good!.definition.profileId} of application .* cannot be read; an administrator must register the project's setup again`));
    expect(() => parseAccountEntry("payments", ORDERS_APPLICATION_ID, good!.definition.profileId, goodRows.latest, undefined)).toThrow(/cannot be read/);
  });

  it("keeps an older line of definitions for a contract the latest was not registered for", () => {
    const changed = contractOf(ordersManifestWith((e2e) => { withOwnerB(e2e); withViewerRole("auditor")(e2e); }));
    const first = entriesOf(fourWritten()).find((entry) => entry.definition.profileId === "orders-viewer")!;
    const second = planSyntheticAccountWrites({ contract: changed, applicationId: ORDERS_APPLICATION_ID, prior: [first], now: T0 + DAY }).find((write) => write.definition.profileId === "orders-viewer")!;
    const entry = { definition: second.definition, latest: second.latest, earlier: [first.definition] };
    const args = { entries: [entry], applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer", now: T0 + DAY };
    expect(latestAccountRef({ ...args, contract: changed }).revision).toBe(2);
    expect(latestAccountRef({ ...args, contract: four }).revision).toBe(1);
    expect(() => latestAccountRef({ ...args, contract: four, now: T0 + 90 * DAY })).toThrow(/accounts-changed-reapprove.*newer setup.*start the task again/s);
    expect(() => latestAccountRef({ ...args, entries: [{ ...entry, earlier: [] }], contract: four })).toThrow(/newer setup/);
  });

  it("keys a definition and its latest pointer in the project's partition, as the plan lays them out", () => {
    expect(e2eAccountDefinitionKey("payments", "orders-app", "orders-viewer", 3)).toEqual({ pk: "PROJECT#payments", sk: "E2E_ACCOUNT#orders-app#orders-viewer#REV#3" });
    expect(e2eAccountLatestKey("payments", "orders-app", "orders-viewer")).toEqual({ pk: "PROJECT#payments", sk: "E2E_ACCOUNT_LATEST#orders-app#orders-viewer" });
    expect(() => e2eAccountLatestKey("payments", "orders#app", "orders-viewer")).toThrow();
  });
});

describe("one application with two accounts (an owner and a viewer)", () => {
  const entries = entriesOf(fourWritten());

  it("looks each account up by its application and profile, and finds the one that was asked for", () => {
    const owner = pickAccountEntry(entries, ORDERS_APPLICATION_ID, "orders-owner");
    const viewer = pickAccountEntry(entries, ORDERS_APPLICATION_ID, "orders-viewer");
    expect(owner.definition.profileId).toBe("orders-owner");
    expect(viewer.definition.profileId).toBe("orders-viewer");
    expect(owner.definition.roleRef).toBe("owner");
    expect(viewer.definition.roleRef).toBe("viewer");
    const ownerRef = latestAccountRef({ contract: four, entries, applicationId: ORDERS_APPLICATION_ID, profileId: "orders-owner", now: T0 });
    const viewerRef = latestAccountRef({ contract: four, entries, applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer", now: T0 });
    expect(ownerRef.profileId).toBe("orders-owner");
    expect(viewerRef.profileId).toBe("orders-viewer");
    expect(ownerRef.definitionDigest).not.toBe(viewerRef.definitionDigest);
  });

  it("refuses an account with no definition and an account with more than one, by name, and never falls back to the application's first", () => {
    expect(() => pickAccountEntry(entries.filter((entry) => entry.definition.profileId !== "orders-viewer"), ORDERS_APPLICATION_ID, "orders-viewer"))
      .toThrow(new E2EAccountRegistryError("account-not-registered", `no account definition is registered for account profile orders-viewer of application ${ORDERS_APPLICATION_ID}`));
    const duplicated = [...entries, { ...entries.find((entry) => entry.definition.profileId === "orders-viewer")! }];
    expect(() => pickAccountEntry(duplicated, ORDERS_APPLICATION_ID, "orders-viewer"))
      .toThrow(`more than one account definition is registered for account profile orders-viewer of application ${ORDERS_APPLICATION_ID}`);
    expect(() => pickAccountEntry(entries, "another-application", "orders-viewer")).toThrow(E2EAccountRegistryError);
  });
});

// ---- plan approval, dispatch and verification against the registry (the pure derivation both use) ----

describe("approving a plan against the account registry", () => {
  const evaluate = (options: { registry?: E2EAccountRegistryEntry[]; accountRef?: { revision?: number; definitionDigest?: string }; mode?: "approve" | "reapprove" | "current";
    pinned?: ReturnType<typeof deriveE2ESyntheticRuntimeAccountRef>[]; now?: number; mutateIntent?: (intent: ReturnType<typeof planFixture>["intent"]) => unknown } = {}) => {
    const fx = planFixture(options.accountRef === undefined ? {} : { accountRef: options.accountRef });
    const intent = options.mutateIntent === undefined ? fx.intent : E2EApplicationPlanIntentSchema.parse(options.mutateIntent(fx.intent));
    return { fx, result: evaluateApplicationPlanApproval({ intent, taskId: "11111111-1111-4111-8111-111111111111", artifact: { id: "feature-plan", sha256: "1".repeat(64) },
      snapshot: fx.snapshot, setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: [webApiRow("web")],
      runtimeCatalogId: "catalog", runtimeBinding: binding, now: options.now ?? NOW,
      accounts: { entries: options.registry ?? fx.registry, mode: options.mode ?? "approve", pinned: options.pinned ?? [] } }) };
  };
  const reasonOf = (result: ReturnType<typeof evaluate>["result"]) => (result.ok ? "approved" : result.reason);
  const bump = (entries: E2EAccountRegistryEntry[]): E2EAccountRegistryEntry[] => entries.map((entry) => {
    const definition = { ...entry.definition, revision: entry.definition.revision + 1 };
    return { definition, latest: { revision: definition.revision, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) } };
  });

  it("approves the latest registered ref and pins it in the selection", () => {
    const { fx, result } = evaluate();
    expect(result.ok, reasonOf(result)).toBe(true);
    if (!result.ok) return;
    expect(result.accountRefs).toEqual([fx.accountRef]);
    expect(E2EApplicationSelectionRecordSchema.parse(result.selection).accountRefs).toEqual([fx.accountRef]);
  });

  it("refuses a stale revision with accounts-changed-reapprove", () => {
    const { fx, result } = evaluate({ registry: bump(planFixture({}).registry) });
    expect(fx.accountRef.revision).toBe(1);
    expect(result).toMatchObject({ ok: false, scope: "accounts" });
    expect(reasonOf(result)).toContain("accounts-changed-reapprove");
  });

  it("refuses the M1.2 stand-in ref: a new approval never accepts it", () => {
    const fx = planFixture({});
    const standIn = deriveE2ESyntheticRuntimeAccountRef({ applicationId: fx.application.applicationId, accountProfileId: fx.target.accountProfileId, recipeDigest: fx.application.recipe!.recipeDigest });
    const { result } = evaluate({ accountRef: { revision: standIn.revision, definitionDigest: standIn.definitionDigest } });
    expect(result).toMatchObject({ ok: false, scope: "accounts" });
    expect(reasonOf(result)).toContain("accounts-changed-reapprove");
  });

  it("refuses an expired definition", () => {
    const { result } = evaluate({ now: NOW + 91 * DAY });
    expect(result).toMatchObject({ ok: false, scope: "accounts" });
    expect(reasonOf(result)).toMatch(/accounts-changed-reapprove.*expired/);
  });

  it("refuses a definition whose tenant digest is not the contract's, although its digest is the latest", () => {
    const fx = planFixture({});
    const registry = fx.registry.map((entry) => {
      const definition = { ...entry.definition, tenantIdDigest: "f".repeat(64) };
      return { definition, latest: { revision: definition.revision, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) } };
    });
    const tampered = deriveE2EApplicationRuntimeAccountRef(registry[0]!.definition);
    const { result } = evaluate({ registry, accountRef: { definitionDigest: tampered.definitionDigest } });
    expect(result).toMatchObject({ ok: false, scope: "accounts" });
    expect(reasonOf(result)).toContain("accounts-changed-reapprove");
  });

  it("refuses an account that has no definition, saying which account", () => {
    const { fx, result } = evaluate({ registry: [] });
    expect(result).toMatchObject({ ok: false, scope: "accounts" });
    expect(reasonOf(result)).toContain(`account profile ${fx.target.accountProfileId} of application ${fx.application.applicationId}`);
  });

  it("verifies a stored plan that leaves out the keys the schema defaults, by comparing the parsed refs", () => {
    const fx = planFixture({});
    // The planner's plan does not carry the optional members; the account ref is compared as the schema reads it, not as the stored JSON spells it.
    const { portableOperationRefs: _a, mockFixtureRefs: _b, unavailableTargetRefs: _c, ...stored } = fx.intent;
    void _a; void _b; void _c;
    const { result } = evaluate({ mutateIntent: () => stored });
    expect(result.ok, reasonOf(result)).toBe(true);
    const current = evaluate({ mutateIntent: () => stored, mode: "current", pinned: [fx.accountRef] }).result;
    expect(current.ok, reasonOf(current)).toBe(true);
  });

  describe("after approval (re-approval, dispatch and verification)", () => {
    it("dispatch accepts the pinned ref while the registry still holds it", () => {
      const fx = planFixture({});
      const { result } = evaluate({ mode: "current", pinned: [fx.accountRef] });
      expect(result.ok, reasonOf(result)).toBe(true);
    });

    it("dispatch refuses a changed ref with accounts-changed-reapprove, and the refusal says which account", () => {
      const fx = planFixture({});
      const { result } = evaluate({ mode: "current", pinned: [fx.accountRef], registry: bump(fx.registry) });
      expect(result).toMatchObject({ ok: false, scope: "accounts" });
      expect(reasonOf(result)).toMatch(/accounts-changed-reapprove/);
      expect(reasonOf(result)).toContain(fx.target.accountProfileId);
    });

    it("dispatch refuses a definition whose tenant digest is not the contract's, even when it is the latest and the pinned one (registry tampering)", () => {
      const fx = planFixture({});
      const registry = fx.registry.map((entry) => {
        const definition = { ...entry.definition, tenantIdDigest: "f".repeat(64) };
        return { definition, latest: { revision: definition.revision, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) } };
      });
      const tampered = deriveE2EApplicationRuntimeAccountRef(registry[0]!.definition);
      const { result } = evaluate({ mode: "current", pinned: [tampered], registry, accountRef: { definitionDigest: tampered.definitionDigest } });
      expect(result).toMatchObject({ ok: false, scope: "accounts" });
      expect(reasonOf(result)).toContain("accounts-changed-reapprove");
    });

    it("dispatch never reads the stand-in for an account the record pinned nothing for, once it pinned any other (an M1.3 record)", () => {
      const fx = planFixture({});
      const standIn = deriveE2ESyntheticRuntimeAccountRef({ applicationId: fx.application.applicationId, accountProfileId: fx.target.accountProfileId, recipeDigest: fx.application.recipe!.recipeDigest });
      const elsewhere = { applicationId: fx.application.applicationId, profileId: "orders-viewer", revision: 1, definitionDigest: "4".repeat(64) };
      const { result } = evaluate({ mode: "current", pinned: [elsewhere], registry: [], accountRef: standIn });
      expect(result).toMatchObject({ ok: false, scope: "accounts" });
      expect(reasonOf(result)).toContain("no pinned account reference");
    });

    it("dispatch refuses when the pinned ref's definition is gone from the registry", () => {
      const fx = planFixture({});
      const { result } = evaluate({ mode: "current", pinned: [fx.accountRef], registry: [] });
      expect(result).toMatchObject({ ok: false, scope: "accounts" });
    });

    it("re-approval pins the latest ref although the stored plan still carries the one it was approved with", () => {
      const fx = planFixture({});
      const registry = bump(fx.registry);
      const { result } = evaluate({ mode: "reapprove", pinned: [fx.accountRef], registry });
      expect(result.ok, reasonOf(result)).toBe(true);
      if (!result.ok) return;
      expect(result.accountRefs).toEqual([deriveE2EApplicationRuntimeAccountRef(registry[0]!.definition)]);
      expect(result.accountRefs[0]!.revision).toBe(2);
    });

    it("reads an M1.2 record as it is: the recipe-derived ref is accepted at dispatch while the registry holds nothing for the account", () => {
      const fx = planFixture({});
      const standIn = deriveE2ESyntheticRuntimeAccountRef({ applicationId: fx.application.applicationId, accountProfileId: fx.target.accountProfileId, recipeDigest: fx.application.recipe!.recipeDigest });
      const { result } = evaluate({ mode: "current", pinned: [], registry: [], accountRef: standIn });
      expect(result.ok, reasonOf(result)).toBe(true);
      // A ref that is neither the registry's nor the stand-in is not an M1.2 record.
      expect(evaluate({ mode: "current", pinned: [], registry: [], accountRef: { definitionDigest: "9".repeat(64) } }).result).toMatchObject({ ok: false });
      // And once the registry holds the account, the old record has to be approved again.
      const registered = evaluate({ mode: "current", pinned: [], accountRef: standIn }).result;
      expect(registered).toMatchObject({ ok: false, scope: "accounts" });
    });
  });
});

describe("the retry offered when the test accounts changed", () => {
  const blocked = (blockReason: string) => WorkflowSnapshotSchema.parse({ schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: "11111111-1111-4111-8111-111111111111",
    ownerId: "a".repeat(64), path: "QUICK", revision: 6, stage: "VERIFY", state: "BLOCKED", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    artifacts: [], decisions: [], blockReason, e2e: { contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64),
      required: true, currentGroupRunIds: [], resultRefs: [], applicationSelection: undefined } });

  it("tells the owner in Slack and on the page to approve the checks again", () => {
    const workflow = blocked(`${WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX}the account for orders-viewer changed`);
    const slack = taskPageStage(workflow, false, true);
    expect(slack.nextStep).toMatch(/^The test accounts changed; approve the checks again/);
    expect(slack.nextStep).not.toMatch(/send it back/i);
    expect(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX).toMatch(/^The test accounts changed; approve the checks again/);
  });

  it("is offered like a requalified runtime: one retry approves the plan again", () => {
    const base = { stage: "VERIFY", state: "BLOCKED", blockReason: `${WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX}x`, e2e: { required: true, applicationSelection: {} } };
    expect(workflowApplicationRetryOffered(base)).toBe(true);
    expect(workflowApplicationRetryOffered({ ...base, blockReason: "something else" })).toBe(false);
  });
});

// ---- through the broker ----

describe("the broker's project registration writes the accounts (Task 3.1, owner decision D5)", () => {
  const admin = { subject: "admin-subject", admin: true };
  const otherAdmin = { subject: "another-projects-admin", admin: true };
  type Proposal = { ref: string; sha: string; policy: unknown };
  async function brokerWith(initial: ReturnType<typeof snapshotOf>) {
    const source = { current: initial };
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture: async () => source.current }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog" } });
    const projectRows = () => harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")
      .sort((left, right) => Number((left.definition as { revision: number }).revision) - Number((right.definition as { revision: number }).revision));
    const propose = async (user = admin): Promise<Proposal> => {
      const response = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return { ref: String(response.body.proposalRef), sha: String(response.body.proposalSha256), policy: response.body.policy };
    };
    /** `approvedAt` pins the order in which setups were approved (the table stamps the clock, which can repeat within a millisecond). */
    const approve = async (proposal: Proposal, approvedAt?: string, user = admin) => {
      const response = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user,
        body: { projectName: "payments", proposalRef: proposal.ref, proposalSha256: proposal.sha, decision: "approve" } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      if (approvedAt !== undefined) harness.db.set({ ...harness.db.get("PROJECT_SETUP#payments", `PROPOSAL#${proposal.sha}`)!, approvedAt });
    };
    const register = (proposal: Proposal, user = admin, revision?: number) => {
      const rows = projectRows();
      const definition = rows.at(-1)!.definition as Record<string, unknown> & { revision: number };
      return call(harness.handler, { method: "POST", path: "/v1/admin/projects", user,
        body: { definition: { ...definition, revision: revision ?? Number((rows.at(-1)!.definition as { revision: number }).revision) + 1, e2e: proposal.policy }, runtimeBinding: rows.at(-1)!.runtimeBinding,
          setupApproval: { proposalRef: proposal.ref, proposalSha256: proposal.sha, decision: "approve" } } });
    };
    const rows = () => harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).startsWith("E2E_ACCOUNT")).map((row) => String(row.sk)).sort();
    const latest = (): Record<string, number> => Object.fromEntries(harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#"))
      .map((row): [string, number] => [String(row.sk).split("#")[2]!, Number(row.revision)]));
    const latestRow = (profile: string) => harness.db.get("PROJECT#payments", `E2E_ACCOUNT_LATEST#${ORDERS_APPLICATION_ID}#${profile}`);
    const definitionRow = (profile: string, revision: number) => harness.db.get("PROJECT#payments", `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#${profile}#REV#${revision}`);
    return { harness, source, propose, approve, register, rows, latest, latestRow, definitionRow, projectRows };
  }
  const fourSnapshot = (...edits: Array<(e2e: Parameters<typeof withOwnerB>[0]) => void>) =>
    snapshotOf({ "package.json": ordersManifestWith((e2e) => { withOwnerB(e2e); for (const edit of edits) edit(e2e); }) });
  const T1 = "2026-10-01T00:00:00.000Z";
  const T2 = "2026-10-02T00:00:00.000Z";
  const PROFILES = ["synthetic", "orders-owner", "orders-viewer", "orders-owner-b"];

  it("changes nothing when a setup is approved but not registered", async () => {
    const broker = await brokerWith(fourSnapshot());
    await broker.approve(await broker.propose());
    expect(broker.rows()).toEqual([]);
  });

  it("writes revision 1 of the four profiles of the fixture contract with the project revision, in one transaction, and records which setup approval wrote them", async () => {
    const broker = await brokerWith(fourSnapshot());
    const proposal = await broker.propose();
    await broker.approve(proposal, T1);
    const transactions: Array<Array<{ Put?: { Item?: Record<string, unknown> } }>> = [];
    const send = broker.harness.db.send.bind(broker.harness.db);
    broker.harness.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") transactions.push((command as unknown as { input: { TransactItems: Array<{ Put?: { Item?: Record<string, unknown> } }> } }).input.TransactItems);
      return send(command);
    };
    const registered = await broker.register(proposal);
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    const withAccounts = transactions.filter((items) => items.some((item) => String(item.Put?.Item?.sk).startsWith("E2E_ACCOUNT")));
    expect(withAccounts).toHaveLength(1);
    expect(withAccounts[0]!.some((item) => item.Put?.Item?.entityType === "PROJECT")).toBe(true);
    expect(broker.rows()).toEqual(PROFILES.flatMap((profile) => [`E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#${profile}#REV#1`, `E2E_ACCOUNT_LATEST#${ORDERS_APPLICATION_ID}#${profile}`]).sort());
    expect(broker.latest()).toEqual({ synthetic: 1, "orders-owner": 1, "orders-viewer": 1, "orders-owner-b": 1 });
    expect(broker.definitionRow("orders-owner-b", 1)).toMatchObject({ entityType: "E2E_ACCOUNT", profileId: "orders-owner-b", tenantIdDigest: sha256Hex(canonicalJson("tenant-b")), credentialHandleId: null, connectionRef: null });
    expect(broker.latestRow("orders-viewer")).toMatchObject({ setupApprovedAt: T1, setupProposalSha256: proposal.sha });
  });

  it("writes nothing when the same setup is registered again, and revision 2 of orders-viewer only when a newer setup changes its role", async () => {
    const broker = await brokerWith(fourSnapshot());
    const first = await broker.propose();
    await broker.approve(first, T1);
    expect((await broker.register(first)).status).toBe(201);
    const before = broker.rows();
    expect((await broker.register(first)).status).toBe(201);
    expect(broker.rows()).toEqual(before);
    broker.source.current = fourSnapshot(withViewerRole("auditor"));
    const second = await broker.propose();
    await broker.approve(second, T2);
    expect((await broker.register(second)).status).toBe(201);
    expect(broker.latest()).toEqual({ synthetic: 1, "orders-owner": 1, "orders-viewer": 2, "orders-owner-b": 1 });
    expect(broker.rows().filter((sk) => sk.includes("#REV#2"))).toEqual([`E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#orders-viewer#REV#2`]);
    expect(broker.definitionRow("orders-viewer", 2)).toMatchObject({ roleRef: "auditor", revision: 2 });
    // Revision 1 stays as it was: the registry only appends.
    expect(broker.definitionRow("orders-viewer", 1)).toMatchObject({ roleRef: "viewer", revision: 1 });
    expect(broker.latestRow("orders-viewer")).toMatchObject({ setupApprovedAt: T2, setupProposalSha256: second.sha });
  });

  it("writes no definition for a declined setup", async () => {
    const broker = await brokerWith(fourSnapshot());
    const proposal = await broker.propose();
    const declined = await call(broker.harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin,
      body: { projectName: "payments", proposalRef: proposal.ref, proposalSha256: proposal.sha, decision: "decline" } });
    expect(declined.status).toBe(200);
    expect(broker.rows()).toEqual([]);
  });

  it("refuses to register an older approved setup over a newer one, rolls no account back, and registers no project revision", async () => {
    const broker = await brokerWith(fourSnapshot());
    const older = await broker.propose();
    await broker.approve(older, T1);
    broker.source.current = fourSnapshot(withViewerRole("auditor"));
    const newer = await broker.propose();
    await broker.approve(newer, T2);
    expect((await broker.register(older)).status).toBe(201);
    expect((await broker.register(newer)).status).toBe(201);
    expect(broker.definitionRow("orders-viewer", 2)).toMatchObject({ roleRef: "auditor" });
    const rowsBefore = broker.rows();
    const revisionsBefore = broker.projectRows().length;
    const rollback = await broker.register(older);
    expect(rollback.status, JSON.stringify(rollback.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(rollback.body)).toMatch(/newer approved setup.*orders-viewer.*roll the account back/s);
    expect(broker.rows()).toEqual(rowsBefore);
    expect(broker.latest()["orders-viewer"]).toBe(2);
    expect(broker.projectRows()).toHaveLength(revisionsBefore);
  });

  it("lets only an administrator of the project register a setup that writes its accounts", async () => {
    const broker = await brokerWith(fourSnapshot());
    const proposal = await broker.propose();
    await broker.approve(proposal, T1);
    expect((await broker.register(proposal)).status).toBe(201);
    const rowsBefore = broker.rows();
    // Another administrator, with a setup of their own approval for the same project name, does not get to write this project's accounts.
    broker.source.current = fourSnapshot(withViewerRole("auditor"));
    const theirs = await broker.propose(otherAdmin);
    await broker.approve(theirs, T2, otherAdmin);
    const refused = await broker.register(theirs, otherAdmin);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("administrator of project payments");
    expect(broker.rows()).toEqual(rowsBefore);
    // Nor with the first administrator's approval: it is bound to its owner.
    const stolen = await broker.register(proposal, otherAdmin);
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    expect(broker.rows()).toEqual(rowsBefore);
    expect(broker.harness.db.find((row) => row.pk === "PROJECT#billing")).toEqual([]);
  });

  it("stays correct when two registrations race for the same accounts: one revision between them, whichever setup wins", async () => {
    const same = await brokerWith(fourSnapshot());
    const proposal = await same.propose();
    await same.approve(proposal, T1);
    const raced = await Promise.all([same.register(proposal), same.register(proposal, admin, same.projectRows().length + 100)]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 201]);
    expect(same.latest()).toEqual({ synthetic: 1, "orders-owner": 1, "orders-viewer": 1, "orders-owner-b": 1 });
    expect(same.rows().filter((sk) => sk.includes("#REV#"))).toHaveLength(4);

    const different = await brokerWith(fourSnapshot());
    const older = await different.propose();
    await different.approve(older, T1);
    different.source.current = fourSnapshot(withViewerRole("auditor"));
    const newer = await different.propose();
    await different.approve(newer, T2);
    expect((await different.register(older)).status).toBe(201);
    const results = await Promise.all([different.register(older, admin, 40), different.register(newer, admin, 41)]);
    // The newer setup always ends up registered; the older one either went in first or was refused as superseded, never over it.
    expect(results.some((response) => response.status === 201)).toBe(true);
    expect(different.definitionRow("orders-viewer", different.latest()["orders-viewer"]!)).toMatchObject({ roleRef: "auditor" });
    expect(different.latest()["orders-owner"]).toBe(1);
  });

  it("remembers a newer setup that registered unchanged: an older setup that changes the role is still refused afterwards (S1, S3 identical to S1, then S2)", async () => {
    const broker = await brokerWith(fourSnapshot());
    const s1 = await broker.propose();
    await broker.approve(s1, "2026-10-01T00:00:00.000Z");
    broker.source.current = fourSnapshot(withViewerRole("auditor"));
    const s2 = await broker.propose();
    await broker.approve(s2, "2026-10-02T00:00:00.000Z");
    // S3 declares exactly S1's accounts (only an unrelated file differs, so it is a proposal of its own), approved after S2.
    broker.source.current = snapshotOf({ "package.json": ordersManifestWith(withOwnerB), "README.md": "the same accounts as S1\n" });
    const s3 = await broker.propose();
    await broker.approve(s3, "2026-10-03T00:00:00.000Z");
    expect((await broker.register(s1)).status).toBe(201);
    expect((await broker.register(s3)).status).toBe(201);
    expect(broker.latest()).toEqual({ synthetic: 1, "orders-owner": 1, "orders-viewer": 1, "orders-owner-b": 1 });
    expect(broker.latestRow("orders-viewer")).toMatchObject({ setupApprovedAt: "2026-10-03T00:00:00.000Z", setupProposalSha256: s3.sha });
    const refused = await broker.register(s2);
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toMatch(/newer approved setup.*orders-viewer.*roll the account back/s);
    expect(broker.latest()["orders-viewer"]).toBe(1);
    expect(broker.definitionRow("orders-viewer", 2)).toBeUndefined();
  });

  it("treats a pointer that records no setup approval as the oldest: a registration backfills it, and a later older setup is then refused", async () => {
    const broker = await brokerWith(fourSnapshot());
    const s1 = await broker.propose();
    await broker.approve(s1, "2026-10-02T00:00:00.000Z");
    expect((await broker.register(s1)).status).toBe(201);
    const { setupApprovedAt: _approvedAt, setupProposalSha256: _sha, ...bare } = broker.latestRow("orders-viewer")!;
    void _approvedAt; void _sha;
    broker.harness.db.set(bare);
    expect(broker.latestRow("orders-viewer")).not.toHaveProperty("setupApprovedAt");
    expect((await broker.register(s1)).status).toBe(201);
    expect(broker.latestRow("orders-viewer")).toMatchObject({ setupApprovedAt: "2026-10-02T00:00:00.000Z" });
    broker.source.current = fourSnapshot(withViewerRole("auditor"));
    const older = await broker.propose();
    await broker.approve(older, "2026-10-01T00:00:00.000Z");
    expect((await broker.register(older)).status).toBeGreaterThanOrEqual(400);
    expect(broker.latest()["orders-viewer"]).toBe(1);
  });

  it("checks the administrator authority again on every attempt: of two administrators racing a first registration of a new project name, the loser is refused", async () => {
    const broker = await brokerWith(fourSnapshot());
    const base = broker.projectRows().at(-1)!;
    const proposalFor = async (user: typeof admin) => {
      const response = await call(broker.harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const approval = await call(broker.harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user,
        body: { projectName: "billing", proposalRef: String(response.body.proposalRef), proposalSha256: String(response.body.proposalSha256), decision: "approve" } });
      expect(approval.status, JSON.stringify(approval.body)).toBe(200);
      return response.body;
    };
    const registerBilling = (user: typeof admin, proposal: Record<string, unknown>, revision: number) => call(broker.harness.handler, { method: "POST", path: "/v1/admin/projects", user,
      body: { definition: { ...(base.definition as Record<string, unknown>), name: "billing", revision, e2e: proposal.policy }, runtimeBinding: base.runtimeBinding,
        setupApproval: { proposalRef: String(proposal.proposalRef), proposalSha256: String(proposal.proposalSha256), decision: "approve" } } });
    const first = await proposalFor(admin);
    const second = await proposalFor(otherAdmin);
    // Both see no project yet; the first administrator commits while the second is between planning and commit.
    let committed: Awaited<ReturnType<typeof registerBilling>> | undefined;
    let fired = false;
    const send = broker.harness.db.send.bind(broker.harness.db);
    broker.harness.db.send = async (command) => {
      const items = command.constructor.name === "TransactWriteCommand" ? (command as unknown as { input: { TransactItems: Array<{ Put?: { Item?: Record<string, unknown> } }> } }).input.TransactItems : [];
      if (!fired && items.some((item) => item.Put?.Item?.entityType === "PROJECT" && (item.Put.Item.definition as { revision?: number } | undefined)?.revision === 2)) {
        fired = true;
        committed = await registerBilling(admin, first, 1);
      }
      return send(command);
    };
    const loser = await registerBilling(otherAdmin, second, 2);
    expect(committed?.status, JSON.stringify(committed?.body)).toBe(201);
    expect(loser.status, JSON.stringify(loser.body)).toBe(403);
    expect(JSON.stringify(loser.body)).toContain("administrator of project billing");
    expect(broker.harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string }).name === "billing")).toHaveLength(1);
    // Only the first administrator's setup wrote accounts, once.
    expect(broker.harness.db.find((row) => row.pk === "PROJECT#billing" && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#"))).toHaveLength(4);
    expect(broker.harness.db.find((row) => row.pk === "PROJECT#billing" && String(row.sk).includes("#REV#2"))).toHaveLength(0);
  });

  describe("an account pointer that moves between planning and commit", () => {
    /** Runs `competitor` once, just before the registration's first transaction that writes accounts commits. */
    const beforeAccountTransaction = (broker: Awaited<ReturnType<typeof brokerWith>>, competitor: () => void) => {
      let fired = false;
      const send = broker.harness.db.send.bind(broker.harness.db);
      broker.harness.db.send = async (command) => {
        const items = command.constructor.name === "TransactWriteCommand" ? (command as unknown as { input: { TransactItems: Array<{ Put?: { Item?: Record<string, unknown> } }> } }).input.TransactItems : [];
        if (!fired && items.some((item) => String(item.Put?.Item?.sk).startsWith("E2E_ACCOUNT"))) { fired = true; competitor(); }
        return send(command);
      };
    };
    const twoSetups = async () => {
      const broker = await brokerWith(fourSnapshot());
      const s1 = await broker.propose();
      await broker.approve(s1, "2026-10-01T00:00:00.000Z");
      expect((await broker.register(s1)).status).toBe(201);
      broker.source.current = fourSnapshot(withViewerRole("auditor"));
      const s2 = await broker.propose();
      await broker.approve(s2, "2026-10-02T00:00:00.000Z");
      return { broker, s2 };
    };
    const viewerRevision2 = (broker: Awaited<ReturnType<typeof brokerWith>>, changes: Record<string, unknown>): Record<string, unknown> => {
      const first = broker.definitionRow("orders-viewer", 1)!;
      return { ...first, sk: String(first.sk).replace("#REV#1", "#REV#2"), revision: 2, ...changes };
    };

    it("never overwrites a definition row that already exists, whatever the pointer says", async () => {
      const { broker, s2 } = await twoSetups();
      const projectRevisions = broker.projectRows().length;
      beforeAccountTransaction(broker, () => broker.harness.db.set(viewerRevision2(broker, { roleRef: "competitor" })));
      const response = await broker.register(s2);
      expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
      expect(broker.definitionRow("orders-viewer", 2)).toMatchObject({ roleRef: "competitor" });
      expect(broker.latest()["orders-viewer"]).toBe(1);
      expect(broker.projectRows()).toHaveLength(projectRevisions);
    });

    it("moves a pointer only from the revision it read: a pointer that moved first fails the commit, and the registration plans again and writes after it", async () => {
      const { broker, s2 } = await twoSetups();
      // A competing writer moved the pointer to revision 2 but its definition row is not (yet) there.
      beforeAccountTransaction(broker, () => broker.harness.db.set({ ...broker.latestRow("orders-viewer")!, revision: 2, setupApprovedAt: "2026-10-01T00:00:00.000Z" }));
      const response = await broker.register(s2);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(broker.latest()["orders-viewer"]).toBe(3);
      expect(broker.definitionRow("orders-viewer", 3)).toMatchObject({ roleRef: "auditor", revision: 3 });
      expect(broker.definitionRow("orders-viewer", 2)).toBeUndefined();
    });

    it("refuses, as superseded, when the competing write is a newer setup's: it plans again after the conflict and sees the newer approval", async () => {
      const { broker, s2 } = await twoSetups();
      beforeAccountTransaction(broker, () => {
        const row = viewerRevision2(broker, { roleRef: "newer-role" });
        const { pk: _pk, sk: _sk, entityType: _entity, ...body } = row;
        void _pk; void _sk; void _entity;
        broker.harness.db.set(row);
        broker.harness.db.set({ ...broker.latestRow("orders-viewer")!, revision: 2, definitionDigest: e2eApplicationAccountDefinitionDigest(E2EApplicationAccountDefinitionSchema.parse(body)),
          setupApprovedAt: "2026-10-03T00:00:00.000Z" });
      });
      const response = await broker.register(s2);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body)).toMatch(/newer approved setup.*orders-viewer.*roll the account back/s);
      expect(broker.definitionRow("orders-viewer", 2)).toMatchObject({ roleRef: "newer-role" });
    });
  });

  it("repairs an account whose rows cannot be read by registering the setup again, and leaves the others alone", async () => {
    const broker = await brokerWith(fourSnapshot());
    const proposal = await broker.propose();
    await broker.approve(proposal, T1);
    expect((await broker.register(proposal)).status).toBe(201);
    broker.harness.db.set({ ...broker.latestRow("orders-viewer")!, revision: "garbage" });
    const repaired = await broker.register(proposal);
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(201);
    expect(broker.latest()).toEqual({ synthetic: 1, "orders-owner": 1, "orders-viewer": 2, "orders-owner-b": 1 });
    expect(broker.definitionRow("orders-viewer", 2)).toMatchObject({ roleRef: "viewer", revision: 2 });
    expect(broker.rows().filter((sk) => sk.includes("#REV#2"))).toHaveLength(1);
  });

  describe("renewal: registering the setup again renews a definition before it expires", () => {
    const at = async (days: number, assert: (broker: Awaited<ReturnType<typeof brokerWith>>, proposal: Proposal) => void | Promise<void>) => {
      const broker = await brokerWith(fourSnapshot());
      const proposal = await broker.propose();
      await broker.approve(proposal, T1);
      vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-20T00:00:00.000Z") });
      try {
        expect((await broker.register(proposal)).status).toBe(201);
        vi.setSystemTime(Date.parse("2026-10-20T00:00:00.000Z") + days * DAY);
        await assert(broker, proposal);
      } finally { vi.useRealTimers(); }
    };

    it("writes nothing on day 75, with fifteen days left", () => at(75, async (broker, proposal) => {
      expect((await broker.register(proposal)).status).toBe(201);
      expect(Object.values(broker.latest())).toEqual([1, 1, 1, 1]);
    }));

    it("writes revision 2 with a fresh expiry on day 89, before the definitions expire", () => at(89, async (broker, proposal) => {
      expect((await broker.register(proposal)).status).toBe(201);
      expect(broker.latest()).toEqual({ synthetic: 2, "orders-owner": 2, "orders-viewer": 2, "orders-owner-b": 2 });
      expect(broker.definitionRow("orders-viewer", 2)!.expiresAt).toBe("2027-04-17T00:00:00.000Z");
      expect(broker.definitionRow("orders-viewer", 1)!.expiresAt).toBe("2027-01-18T00:00:00.000Z");
    }));

    it("writes revision 2 on day 91 too, after they expired", () => at(91, async (broker, proposal) => {
      expect((await broker.register(proposal)).status).toBe(201);
      expect(broker.latest()).toEqual({ synthetic: 2, "orders-owner": 2, "orders-viewer": 2, "orders-owner-b": 2 });
    }));
  });
});


describe("a whole round with two accounts of one application", () => {
  const ACCOUNTS = ["orders-owner", "orders-viewer"] as const;

  it("approves each account against its own definition, pins both refs, and admits each case with its own account's ref", async () => {
    const round = await startApplicationRound({ accounts: ACCOUNTS });
    const pinned = E2EApplicationSelectionRecordSchema.parse(round.workflowNow().e2e!.applicationSelection).accountRefs;
    expect(pinned.map((ref) => ref.profileId).sort()).toEqual([...ACCOUNTS]);
    expect(new Set(pinned.map((ref) => ref.definitionDigest)).size).toBe(2);
    for (const profileId of ACCOUNTS) {
      const latest = round.harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).endsWith(`#${profileId}`) && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#"));
      expect(latest, profileId).toHaveLength(1);
      expect(pinned.find((ref) => ref.profileId === profileId)).toMatchObject({ revision: 1, definitionDigest: (latest[0] as unknown as { definitionDigest: string }).definitionDigest });
    }
    expect(round.admission.selectionInput.runtimeAccountRefs.map((ref) => canonicalJson(ref)).sort()).toEqual(pinned.map((ref) => canonicalJson(ref)).sort());
    expect(round.admission.intent.runtimeAccountRefs.map((ref) => canonicalJson(ref)).sort()).toEqual(pinned.map((ref) => canonicalJson(ref)).sort());
  });

  it("binds each compiled case to the ref of its own account: the owner's case to the owner's, the viewer's to the viewer's (the FX3 class of bug)", async () => {
    const round = await startApplicationRound({ accounts: ACCOUNTS });
    const pinned = E2EApplicationSelectionRecordSchema.parse(round.workflowNow().e2e!.applicationSelection).accountRefs;
    const passing = { kind: "http-status", status: 200 } as const satisfies ObservedApiOutcome;
    const group = await round.collectGroup(round.groupIds[0]!, [passing, passing]);
    const inputs = group.collectionInputs as unknown as Omit<Parameters<typeof createE2EApplicationCollectionOracleFromCompiledSuite>[0], "compiled" | "binding" | "round">;
    const oracle = createE2EApplicationCollectionOracleFromCompiledSuite({ compiled: group.compiled, binding: group.binding, round: group.round, environment: inputs.environment, usage: inputs.usage,
      limits: inputs.limits, expectedSupervisorReceiptRefs: inputs.expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: inputs.ownedResourceInventoryDigest,
      observationBindings: inputs.observationBindings, assertionAssets: inputs.assertionAssets, governedModelReceipts: inputs.governedModelReceipts, ownedClosedAt: inputs.ownedClosedAt });
    expect(group.binding.expectedCases.map((item) => item.accountProfileId).sort()).toEqual([...ACCOUNTS]);
    for (const expected of group.binding.expectedCases) {
      const facts = oracle.applicationIdsByCase.find((item) => item.caseId === expected.caseId)!;
      const own = pinned.find((ref) => ref.profileId === expected.accountProfileId)!;
      const registered = round.harness.db.get("PROJECT#payments", `E2E_ACCOUNT_LATEST#${facts.accountRef.applicationId}#${expected.accountProfileId}`) as unknown as { definitionDigest: string };
      expect(facts.accountRef.profileId, expected.caseId).toBe(expected.accountProfileId);
      expect(canonicalJson(facts.accountRef), expected.caseId).toBe(canonicalJson(own));
      expect(facts.accountRef.definitionDigest, expected.caseId).toBe(registered.definitionDigest);
    }
    expect(new Set(oracle.applicationIdsByCase.map((item) => item.accountRef.definitionDigest)).size).toBe(2);
  });

  it("a corrupt row refuses only the plans that run as that account, naming it and the repair, and hides no other account", async () => {
    const corrupt = (round: { harness: { db: Pick<RoundBrokerHarness["db"], "find" | "set"> } }) => {
      const row = round.harness.db.find((item) => item.pk === "PROJECT#payments" && String(item.sk).startsWith("E2E_ACCOUNT_LATEST#") && String(item.sk).endsWith("#orders-viewer"))[0]!;
      round.harness.db.set({ ...row, revision: "garbage" });
    };
    const both = await prepareApplicationRound({ accounts: ACCOUNTS });
    corrupt(both);
    const roundApplicationId = String(both.harness.db.find((item) => String(item.sk).startsWith("E2E_ACCOUNT_LATEST#"))[0]!.sk).split("#")[1]!;
    const refused = await both.approve();
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toMatch(/account profile orders-viewer of application .* cannot be read; an administrator must register the project's setup again to repair it/);
    expect(both.workflowNow().e2e).toBeUndefined();
    // The reader keeps the readable accounts and lists the unreadable one, for the planner and for registration to act on.
    const read = await readAccountRegistryEntries(both.harness.brokerInput as never, "payments", ACCOUNTS.map((profileId) => ({ applicationId: roundApplicationId, profileId })));
    expect(read.entries.map((entry) => entry.definition.profileId)).toEqual(["orders-owner"]);
    expect(read.corrupt).toMatchObject([{ applicationId: roundApplicationId, profileId: "orders-viewer" }]);
    // A plan that runs only as the owner is approved all the same.
    const owner = await prepareApplicationRound({ accounts: ["orders-owner"] });
    corrupt(owner);
    expect((await owner.approve()).status).toBe(200);
  });

  it("holds the verdict to the registry too: authority is valid while it holds the pinned refs, and not once one account has a newer revision", async () => {
    const round = await startApplicationRound({ accounts: ACCOUNTS });
    const broker = await import("../../packages/broker/src/aws/broker.js");
    const valid: { reason?: string; runtimeChange?: "requalified" | "unusable" | "accounts" } = {};
    expect(await broker.workflowE2EApplicationAuthorityIsValid(round.harness.brokerInput as never, round.taskNow() as never, round.candidate, round.admission, valid), valid.reason).toBe(true);
    const key = round.harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).endsWith("#orders-owner") && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#"))[0]!;
    const current = round.harness.db.get("PROJECT#payments", String(key.sk).replace("E2E_ACCOUNT_LATEST#", "E2E_ACCOUNT#") + "#REV#1")!;
    const { pk: _pk, sk: _sk, entityType: _entity, ...body } = current;
    void _pk; void _sk; void _entity;
    const next = E2EApplicationAccountDefinitionSchema.parse({ ...body, revision: 2, expiresAt: new Date(Date.now() + 100 * DAY).toISOString() });
    round.harness.db.set({ pk: current.pk, sk: String(current.sk).replace("#REV#1", "#REV#2"), entityType: "E2E_ACCOUNT", ...next });
    round.harness.db.set({ ...key, revision: 2, definitionDigest: e2eApplicationAccountDefinitionDigest(next) });
    const moved: { reason?: string; runtimeChange?: "requalified" | "unusable" | "accounts" } = {};
    expect(await broker.workflowE2EApplicationAuthorityIsValid(round.harness.brokerInput as never, round.taskNow() as never, round.candidate, round.admission, moved)).toBe(false);
    expect(moved.reason).toContain("accounts-changed-reapprove");
    expect(moved.reason).toContain("orders-owner");
    expect(moved.runtimeChange).toBe("accounts");
  });

  it("refuses to approve the plan when one of the two accounts moved to a new revision after the plan was written", async () => {
    const prepared = await prepareApplicationRound({ accounts: ACCOUNTS });
    const { harness } = prepared;
    const key = harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).endsWith("#orders-viewer") && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#"))[0]!;
    const current = harness.db.get("PROJECT#payments", String(key.sk).replace("E2E_ACCOUNT_LATEST#", "E2E_ACCOUNT#") + "#REV#1")!;
    const { pk: _pk, sk: _sk, entityType: _entity, ...body } = current;
    void _pk; void _sk; void _entity;
    const next = E2EApplicationAccountDefinitionSchema.parse({ ...body, revision: 2 });
    harness.db.set({ pk: current.pk, sk: String(current.sk).replace("#REV#1", "#REV#2"), entityType: "E2E_ACCOUNT", ...next });
    harness.db.set({ ...key, revision: 2, definitionDigest: e2eApplicationAccountDefinitionDigest(next) });
    const refused = await prepared.approve();
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("accounts-changed-reapprove");
    expect(JSON.stringify(refused.body)).toContain("orders-viewer");
    // The owner's account for the other profile is not what was refused, and nothing was approved.
    expect(JSON.stringify(refused.body)).not.toContain("orders-owner");
    expect(prepared.workflowNow().e2e).toBeUndefined();
  });
});

describe("the registry rows", () => {
  it("are what the fixtures build for a source: one revision-1 definition per synthetic profile", () => {
    const entries = registryFor(snapshotOf({ "package.json": ordersManifestWith(withOwnerB) }), T0);
    expect(entries.map((entry) => entry.definition.profileId).sort()).toEqual(["orders-owner", "orders-owner-b", "orders-viewer", "synthetic"]);
    expect(entries.every((entry) => entry.definition.revision === 1)).toBe(true);
  });
});
