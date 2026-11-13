// The merge gate of the change tier: at merge the tier is recomputed from the code host's view of the change, and a change that grew past the tier its approval was given at is refused in plain words.
// Driven through the real press (`pressMerge`) on the fake code host; the host here gives the patch text GitHub gives (the fake gives none).
import { describe, expect, it } from "vitest";
import type { ChangeRequestFilesPage, ChangeRequestRef, CodeHost, HostScope } from "../../packages/contracts/src/index.js";
import { FakeCodeHost, type FakeHostModel } from "@agentx/broker/fakes";
import { pressMerge, prepareMerge } from "../../packages/broker/src/core/merge/index.js";
import { recordTierReview, tierFromDiff, type TierLevel } from "../../packages/broker/src/core/decisions/change-tier.js";
import { ORG, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const AT = "2026-11-09T10:00:00.000Z";

type Mode = { patches: boolean; failing: boolean; calls: number };

/** A host that calls itself github. The fake lists each file with the text of its change, as GitHub does; this one can be told to leave the text out, or to fail. */
function patchingHost(model: FakeHostModel, mode: Mode): CodeHost {
  const fake = new FakeCodeHost(model);
  return Object.create(fake, {
    kind: { value: "github" },
    changedFiles: {
      value: async (ref: ChangeRequestRef, page: number, scope: HostScope): Promise<ChangeRequestFilesPage> => {
        mode.calls += 1;
        if (mode.failing) throw new Error("the host is down");
        const read = await fake.changedFiles(ref, page, scope);
        return mode.patches ? read : { ...read, files: read.files.map(({ patch: _patch, ...file }) => file) }; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
      },
    },
  }) as CodeHost;
}

const tierOf = async (world: MergeWorld) => (await world.task()).workflow.flow?.tier;
const rejects = async (run: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try { await run(); } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { ...(code === undefined ? {} : { code }), message: code !== undefined && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message };
  }
  throw new Error("expected a refusal");
};

/** The review steps of a tier ran on the head the pull request has now (what the stage-selection lane records when they finish). */
async function reviewed(world: MergeWorld, level: TierLevel, head = world.prs[0]!.head): Promise<void> {
  const flow = (await world.task()).workflow.flow;
  await world.setWorkflow({ flow: recordTierReview(flow, { level, headSha: head, findings: 0, mustFix: 0 }) });
}

async function worldAt(level: "small" | "standard" | "risky", mode: Mode = { patches: true, failing: false, calls: 0 }) {
  const world = await mergeWorld({ codeHost: (model) => patchingHost(model, mode), withoutTier: true });
  await world.seedTracking();
  const flow = { rulesVersion: 1, tier: { level, kinds: ["code_config"], source: "diff", reasons: [], at: AT } };
  await world.setWorkflow({ flow });
  return { world, mode };
}
const press = async (world: MergeWorld) => {
  const prepared = await prepareMerge(world.deps, { taskId: TASK_ID, requestId: world.requestId() });
  return { prepared, run: () => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }) };
};
/** A later push to the pull request's branch: the host's head moves, and tracking has read it. */
async function pushed(world: MergeWorld, changes: Record<string, string | null>): Promise<void> {
  const pr = world.prs[0]!;
  const branch = pr.model.getChangeRequest(String(pr.number)).sourceBranch;
  const head = pr.model.commit(branch, changes);
  pr.head = head;
  pr.model.setChecks(head, [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId: "11" }]);
  pr.model.addReview(String(pr.number), { login: "priya", state: "APPROVED" });
  await world.seedTracking({ headSha: head, approval: { hostUserId: pr.model.accounts.get("priya")!.hostUserId, login: "priya", commitId: head } });
}

describe("the merge recomputes the change tier from the host", () => {
  it("merges a small change that stays small, and records the tier it found at merge, bound to the head", async () => {
    const { world } = await worldAt("small");
    const { run, prepared } = await press(world);
    expect(prepared.tier).toBe("small");
    expect((await run()).status).toBe("MERGED");
    const tier = await tierOf(world);
    expect(tier).toMatchObject({ level: "small", source: "merge", headSha: world.prs[0]!.head });
  });

  it("refuses a push after approval that adds a sensitive file, names it in plain words, and merges nothing", async () => {
    const { world } = await worldAt("small");
    await pushed(world, { "src/auth/session.ts": "export const session = 1;\n" });
    const { run } = await press(world);
    const refusal = await rejects(run);
    expect(refusal.code).toBe("MERGE_NOT_READY");
    expect(refusal.message).toBe("This change now touches a sensitive path (src/auth/session.ts), so it needs risky checks.");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    expect((await world.trackingOf(world.prs[0]!))!["mergeClaim"]).toBeUndefined();
    expect(await world.auditRows()).toHaveLength(0);
    // The raise is recorded, with where it grew from.
    const flow = (await world.task()).workflow.flow!;
    expect(flow.tier).toMatchObject({ level: "risky", source: "merge" });
    expect(flow.grewAfterBuild).toMatchObject({ from: "small", to: "risky" });
  });

  it("a growth is sticky: a second press does not clear it, the higher tier's review on the current head does", async () => {
    const { world } = await worldAt("small");
    await pushed(world, { "src/auth/session.ts": "export const session = 1;\n" });
    await rejects((await press(world)).run);
    // The raise is recorded and the request is made at the higher tier, yet the merge is still refused: nobody has run the risky checks.
    const again = await press(world);
    expect(again.prepared.tier).toBe("risky");
    expect((await rejects(again.run)).message).toBe("This change now touches a sensitive path (src/auth/session.ts), so it needs risky checks.");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    await reviewed(world, "risky");
    expect((await (await press(world)).run()).status).toBe("MERGED");
  });

  it("a review of a lower tier, or of an older head, does not cover the growth; a push makes a review stale", async () => {
    const { world } = await worldAt("small");
    const oldHead = world.prs[0]!.head;
    await pushed(world, { "src/auth/session.ts": "export const session = 1;\n" });
    await rejects((await press(world)).run);
    await reviewed(world, "standard");
    expect((await rejects((await press(world)).run)).message).toContain("needs risky checks");
    await reviewed(world, "risky", oldHead);
    expect((await rejects((await press(world)).run)).message).toContain("needs risky checks");
    await reviewed(world, "risky");
    await pushed(world, { "src/auth/other.ts": "export const other = 1;\n" });
    expect((await rejects((await press(world)).run)).message).toContain("needs risky checks");
    await reviewed(world, "risky");
    expect((await (await press(world)).run()).status).toBe("MERGED");
  });

  it("a push that removes the sensitive file again leaves the tier up", async () => {
    const { world } = await worldAt("small");
    await pushed(world, { "src/auth/session.ts": "export const session = 1;\n" });
    await rejects((await press(world)).run);
    await pushed(world, { "src/auth/session.ts": null });
    const later = await press(world);
    expect(later.prepared.tier).toBe("risky");
    // The clean diff keeps the tier up, and the owed review is for the head the pull request has now.
    expect((await rejects(later.run)).message).toContain("needs risky checks");
    await reviewed(world, "risky");
    expect((await (await press(world)).run()).status).toBe("MERGED");
    expect((await tierOf(world))?.level).toBe("risky");
  });

  it("a change that grew from small to standard is refused with the size it grew by", async () => {
    const { world } = await worldAt("small");
    await pushed(world, { "src/big.ts": `${Array.from({ length: 150 }, (_, index) => `export const v${index} = ${index};`).join("\n")}\n` });
    const refusal = await rejects((await press(world)).run);
    expect(refusal.message).toBe("This change now touches more than 100 lines of code, so it needs standard checks.");
  });

  it("a tier that was risky is not lowered by a clean diff", async () => {
    const { world } = await worldAt("risky");
    const { run } = await press(world);
    expect((await run()).status).toBe("MERGED");
    expect((await tierOf(world))?.level).toBe("risky");
  });

  it("a host that gives no patch text cannot clear the change: it counts as risky and is refused (fail closed)", async () => {
    const { world } = await worldAt("small", { patches: false, failing: false, calls: 0 });
    const refusal = await rejects((await press(world)).run);
    expect(refusal.message).toBe("This change now touches a file Rovara could not read (src/a.ts), so it needs risky checks.");
  });

  it("a host that cannot list the files refuses the merge and records nothing", async () => {
    const mode: Mode = { patches: true, failing: false, calls: 0 };
    const { world } = await worldAt("small", mode);
    const { run } = await press(world);
    mode.failing = true;
    const refusal = await rejects(run);
    expect(refusal.message).toBe("Rovara couldn't read the changed files from the code host just now, so nothing was merged. Try again in a moment.");
    expect((await tierOf(world))?.source).toBe("diff");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("a task with no recorded tier is judged too, as if approved at the lowest tier: a small change merges and the tier is recorded", async () => {
    const mode: Mode = { patches: true, failing: false, calls: 0 };
    const world = await mergeWorld({ codeHost: (model) => patchingHost(model, mode), withoutTier: true });
    await world.seedTracking();
    const { run, prepared } = await press(world);
    expect(prepared.tier).toBeUndefined();
    expect((await run()).status).toBe("MERGED");
    expect(mode.calls).toBeGreaterThan(0);
    expect(await tierOf(world)).toMatchObject({ level: "small", source: "merge" });
  });

  it("a task with no recorded tier whose change is above small is refused once, then goes through at the tier it was shown", async () => {
    const mode: Mode = { patches: true, failing: false, calls: 0 };
    const world = await mergeWorld({ codeHost: (model) => patchingHost(model, mode), withoutTier: true });
    await world.seedTracking();
    await pushed(world, { "src/auth/session.ts": "export const session = 1;\n" });
    const refusal = await rejects((await press(world)).run);
    expect(refusal.message).toBe("This change now touches a sensitive path (src/auth/session.ts), so it needs risky checks.");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    const again = await press(world);
    expect(again.prepared.tier).toBe("risky");
    await reviewed(world, "risky");
    expect((await (await press(world)).run()).status).toBe("MERGED");
  });

  it("the merge also compares with the tier the planning steps were chosen at: steps skipped at small, a change that is standard now is refused every time", async () => {
    const mode: Mode = { patches: true, failing: false, calls: 0 };
    const world = await mergeWorld({ codeHost: (model) => patchingHost(model, mode), withoutTier: true });
    await world.seedTracking();
    await pushed(world, { "src/big.ts": `${Array.from({ length: 150 }, (_, index) => `export const v${index} = ${index};`).join("\n")}\n` });
    const flow = {
      rulesVersion: 1, tier: { level: "standard", kinds: ["code_config"], source: "diff", reasons: [{ code: "more_than_lines" }], at: AT },
      tierHistory: [{ level: "small", kinds: ["code_config"], source: "estimate", reasons: [], at: AT }], skippedSteps: ["plan_check", "design_review"],
    };
    await world.setWorkflow({ flow });
    // The approval is at standard (the recorded tier), yet the planning steps were skipped at small.
    const first = await press(world);
    expect(first.prepared.tier).toBe("standard");
    expect((await rejects(first.run)).message).toBe("This change now touches more than 100 lines of code, so it needs standard checks.");
    expect((await rejects((await press(world)).run)).message).toContain("needs standard checks");
    // The standard checks ran on this head: nothing is owed, though the steps were skipped.
    await reviewed(world, "standard");
    expect((await (await press(world)).run()).status).toBe("MERGED");
  });

  it("the approval digest names the tier, so an approval given at one tier is not valid at another", async () => {
    const small = await worldAt("small");
    const risky = await worldAt("risky");
    const a = await press(small.world);
    const b = await press(risky.world);
    expect(a.prepared.request.artifactDigest).not.toBe(b.prepared.request.artifactDigest);
  });

  it("agrees with the classifier on what the host shows (one rule, two entry points)", async () => {
    const { world } = await worldAt("small");
    const { run } = await press(world);
    await run();
    const tier = await tierOf(world);
    const direct = tierFromDiff({ files: [{ repository: "app", path: "src/a.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+export const a = 1;" }], complete: true }, { at: AT });
    expect(tier?.level).toBe(direct.level);
    expect(ORG).toBeDefined();
  });
});
