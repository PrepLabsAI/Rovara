import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  E2EApplicationAccountDefinitionSchema, E2EApplicationPlanIntentSchema, E2EApplicationSelectionRecordSchema, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX,
  canonicalJson, createE2ESyntheticAccountDefinition, deriveE2EApplicationRuntimeAccountRef, deriveE2ESyntheticRuntimeAccountRef, e2eApplicationAccountDefinitionDigest,
  e2eSyntheticAccountContractDigest, resolveE2ELatestAccountRef, workflowApplicationRetryOffered, WorkflowSnapshotSchema,
} from "@agentx/contracts";
import {
  E2EAccountRegistryError, e2eAccountDefinitionKey, e2eAccountLatestKey, latestAccountRef, pickAccountEntry, planSyntheticAccountWrites,
  type E2EAccountRegistryEntry,
} from "../../packages/broker/src/e2e/application-account-registry.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { taskPageStage } from "../../packages/broker/src/aws/developer-tasks.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { prepareApplicationRound, startApplicationRound } from "../support/e2e-application-round-harness.js";
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

describe("what a setup approval writes", () => {
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

describe("the broker's setup approval", () => {
  const admin = { subject: "admin-subject", admin: true };
  async function brokerWith(initial: ReturnType<typeof snapshotOf>) {
    const source = { current: initial };
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture: async () => source.current }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog" } });
    const approveSetup = async () => {
      const proposal = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
      expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
      const approval = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin,
        body: { projectName: "payments", proposalRef: String(proposal.body.proposalRef), proposalSha256: String(proposal.body.proposalSha256), decision: "approve" } });
      expect(approval.status, JSON.stringify(approval.body)).toBe(200);
      return approval;
    };
    const rows = () => harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).startsWith("E2E_ACCOUNT")).map((row) => String(row.sk)).sort();
    const latest = (): Record<string, number> => Object.fromEntries(harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#"))
      .map((row): [string, number] => [String(row.sk).split("#")[2]!, Number(row.revision)]));
    return { harness, source, approveSetup, rows, latest };
  }
  const fourSnapshot = (...edits: Array<(e2e: Parameters<typeof withOwnerB>[0]) => void>) =>
    snapshotOf({ "package.json": ordersManifestWith((e2e) => { withOwnerB(e2e); for (const edit of edits) edit(e2e); }) });

  it("writes revision 1 of the four profiles of the fixture contract, writes nothing when the same contract is approved again, and revision 2 of orders-viewer only when its role changes", async () => {
    const broker = await brokerWith(fourSnapshot());
    await broker.approveSetup();
    expect(broker.rows()).toEqual(["orders-owner", "orders-owner-b", "orders-viewer", "synthetic"].flatMap((profile) => [
      `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#${profile}#REV#1`, `E2E_ACCOUNT_LATEST#${ORDERS_APPLICATION_ID}#${profile}`]).sort());
    expect(broker.latest()).toEqual({ synthetic: 1, "orders-owner": 1, "orders-viewer": 1, "orders-owner-b": 1 });
    const stored = broker.harness.db.get("PROJECT#payments", `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#orders-owner-b#REV#1`)!;
    expect(stored).toMatchObject({ entityType: "E2E_ACCOUNT", profileId: "orders-owner-b", tenantIdDigest: sha256Hex(canonicalJson("tenant-b")), credentialHandleId: null, connectionRef: null });
    const before = broker.rows();
    // The same contract again (a duplicate of the stored decision, and then a fresh capture of the same source).
    await broker.approveSetup();
    expect(broker.rows()).toEqual(before);
    broker.source.current = fourSnapshot(withViewerRole("auditor"));
    await broker.approveSetup();
    expect(broker.latest()).toEqual({ synthetic: 1, "orders-owner": 1, "orders-viewer": 2, "orders-owner-b": 1 });
    expect(broker.rows().filter((sk) => sk.includes("#REV#2"))).toEqual([`E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#orders-viewer#REV#2`]);
    expect(broker.harness.db.get("PROJECT#payments", `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#orders-viewer#REV#2`)).toMatchObject({ roleRef: "auditor", revision: 2 });
    // Revision 1 stays as it was: the registry only appends.
    expect(broker.harness.db.get("PROJECT#payments", `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#orders-viewer#REV#1`)).toMatchObject({ roleRef: "viewer", revision: 1 });
  });

  it("writes no definition for a declined setup", async () => {
    const broker = await brokerWith(fourSnapshot());
    const proposal = await call(broker.harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
    const declined = await call(broker.harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin,
      body: { projectName: "payments", proposalRef: String(proposal.body.proposalRef), proposalSha256: String(proposal.body.proposalSha256), decision: "decline" } });
    expect(declined.status).toBe(200);
    expect(broker.rows()).toEqual([]);
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
