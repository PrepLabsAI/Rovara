// Lead 4 PCF on the laptop: what the plan page's data says about the task's feature (the line, the open features of this company only) and what the "Change" and "No feature" action writes (the install owner is a
// maintainer: `moved`, the highest rule, so it can be changed again), only on a coding plan that waits, in this company, at the revision the owner read.
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkflowSnapshot, submitWorkflowArtifact, type JsonValue, type OrgId } from "@agentx/contracts";
import { createLocalPageData, createPageExtraActions } from "../../packages/broker/src/local/app/page-data.js";
import { createFeatureStore } from "../../packages/broker/src/core/report/feature-store.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { TASK } from "../support/local-pages-fakes.js";
import { COMPANY, createHarness, type Harness } from "../support/task-flow-harness.js";

const NOW = "2026-11-17T10:00:00.000Z";
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const OWNER = localOwnerPrincipal();
const SYSTEM = { type: "system", id: "test" } as const;
let h: Harness;

beforeEach(async () => {
  h = createHarness();
  await h.registerProject();
});

const features = (companyId: OrgId = COMPANY) => createFeatureStore({ store: h.store, companyId, audit: h.deps.audit, now: () => h.clock.now });
const deps = () => ({ flow: h.deps, blobs: createDocumentObjectStorage(h.store, { companyId: COMPANY }), owner: OWNER, companyId: COMPANY });
const actions = () => createPageExtraActions(deps());

async function seed(kind: "plan" | "review" | "closed" | "other-company" = "plan") {
  const initial = createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: NOW });
  const waiting = submitWorkflowArtifact(initial, { expectedRevision: initial.revision, now: NOW, artifact: { id: "plan-v1", type: "plan", version: 1, sha256: "a".repeat(64), producer: "agentx-planner", objectKey: `tasks/${TASK}/plan-v1.md`, createdAt: NOW, format: "markdown" } });
  const workflow = kind === "review" ? { ...waiting, stage: "REVIEW", state: "WAITING" } : waiting;
  await h.store.put({ item: {
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, companyId: kind === "other-company" ? OTHER : COMPANY, developerId: "local-owner", provider: "local-owner", developerName: "Local owner", client: "test", project: "payments", title: "Retry failed payments",
    workspaceId: "ws-1", ownerKey: "local-owner", conversationId: "c", startingRevision: 1, charge: { kind: "member", developerId: "local-owner" }, shared: false, createdAt: NOW, updatedAt: NOW,
    workflow: JSON.parse(JSON.stringify(workflow)) as JsonValue, ...(kind === "closed" ? { closedAt: NOW } : {}),
  } });
  return waiting.revision;
}
const page = async () => (await createLocalPageData(deps()).getPlanPage(TASK))!;

describe("the plan page's feature data", () => {
  it("a task with no feature reads as No feature, with this company's open features to pick from (never another company's)", async () => {
    await seed();
    await features().create({ name: "Billing" }, SYSTEM);
    const done = await features().create({ name: "Old work" }, SYSTEM);
    await features().setState(done.id, "done", SYSTEM);
    await features(OTHER).create({ name: "Other company canary" }, SYSTEM);
    const view = (await page()).feature!;
    expect(view).toMatchObject({ line: "Feature: No feature", featureId: null, canChange: true });
    expect(view.choices.map((choice) => choice.name)).toEqual(["Billing"]);
    expect(JSON.stringify(view)).not.toContain("canary");
  });

  it("names the Linear parent the tracker suggested", async () => {
    await seed();
    const parent = await features().create({ name: "Checkout v2", trackerLink: { tracker: "linear", id: "PRJ-1", url: "https://linear.app/x/project/1" } }, SYSTEM);
    await features().setTaskFeature({ taskId: TASK, project: "payments", featureId: parent.id, source: "tracker" }, SYSTEM);
    expect((await page()).feature).toMatchObject({ line: "Feature: Checkout v2 (from the Linear parent)", featureId: parent.id, canChange: true });
  });

  it("is only on a coding plan that waits: a task past plan review has no feature part", async () => {
    await seed("review");
    expect((await page()).feature).toBeUndefined();
  });
});

describe("the plan page's feature action", () => {
  it("Change files the feature as `moved`, and the owner can change it again or file No feature", async () => {
    const revision = await seed();
    const one = await features().create({ name: "One" }, SYSTEM);
    const two = await features().create({ name: "Two" }, SYSTEM);
    const act = actions().planFeature!;
    expect(await act({ taskId: TASK, revision, featureId: one.id })).toMatchObject({ ok: true });
    expect(await features().taskFeature(TASK)).toMatchObject({ featureId: one.id, source: "moved" });
    expect(await act({ taskId: TASK, revision, featureId: two.id })).toMatchObject({ ok: true });
    expect(await features().taskFeature(TASK)).toMatchObject({ featureId: two.id, source: "moved" });
    expect(await act({ taskId: TASK, revision, featureId: null })).toMatchObject({ ok: true });
    expect(await features().taskFeature(TASK)).toMatchObject({ featureId: null, source: "moved" });
    expect((await page()).feature).toMatchObject({ line: "Feature: No feature", canChange: true });
  });

  it("refuses a task that moved on, one that is not waiting on a coding plan, a closed one and another company's, and writes nothing", async () => {
    const revision = await seed();
    const one = await features().create({ name: "One" }, SYSTEM);
    const act = actions().planFeature!;
    expect(await act({ taskId: TASK, revision: revision + 1, featureId: one.id })).toMatchObject({ ok: false, reason: "stale" });
    for (const kind of ["review", "closed", "other-company"] as const) {
      await seed(kind);
      expect(await act({ taskId: TASK, revision, featureId: one.id }), kind).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect(await act({ taskId: "00000000-0000-4000-8000-000000000000", revision, featureId: one.id })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await features().taskFeature(TASK)).toBeUndefined();
  });

  it("refuses another company's feature, a done feature and an unknown one, in plain words, and writes nothing", async () => {
    const revision = await seed();
    const theirs = await features(OTHER).create({ name: "Other company canary" }, SYSTEM);
    const done = await features().create({ name: "Done" }, SYSTEM);
    await features().setState(done.id, "done", SYSTEM);
    const act = actions().planFeature!;
    for (const featureId of [theirs.id, done.id, `ft_${"9".repeat(20)}`]) {
      const result = await act({ taskId: TASK, revision, featureId });
      expect(result).toMatchObject({ ok: false, reason: "refused" });
      expect(JSON.stringify(result)).not.toContain("canary");
    }
    expect(await features().taskFeature(TASK)).toBeUndefined();
  });
});
