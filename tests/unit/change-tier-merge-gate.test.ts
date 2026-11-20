// The merge gate of the change tier: at merge the tier is recomputed from the code host's view of the change, and a change that grew past the tier its approval was given at is refused in plain words.
// Driven through the real press (`pressMerge`) on the fake code host; the host here gives the patch text GitHub gives (the fake gives none).
import { describe, expect, it } from "vitest";
import type { ChangeRequestFilesPage, ChangeRequestRef, CodeHost, HostScope } from "../../packages/contracts/src/index.js";
import { FakeCodeHost, type FakeHostModel } from "@agentx/broker/fakes";
import { pressMerge, prepareMerge } from "../../packages/broker/src/core/merge/index.js";
import { tierGate } from "../../packages/broker/src/core/merge/merge.js";
import { patchDigestOf, recordQuestionsAnswered, recordTierReview, type TierLevel } from "../../packages/broker/src/core/decisions/change-tier.js";
import { readReviewInput } from "../../packages/broker/src/core/merge/change-tier-read.js";
import { ORG, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";
import { MERGE_NOT_READY_MESSAGES as M } from "../../packages/contracts/src/index.js";

const AT = "2026-11-09T10:00:00.000Z";

type Mode = { patches: boolean; failing: boolean; calls: number; afterRead?: (() => void) | undefined };

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
        mode.afterRead?.();
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

/** The reviewer's questions were answered for the head the pull request has now, about the patch the host lists (what the reviewer floor records). `head` and `digest` can be given to make a record for another head or patch. */
async function questioned(world: MergeWorld, head = world.prs[0]!.head, digest?: string): Promise<void> {
  const pr = world.prs[0]!;
  const home = (await world.host.repository("web", 1, pr.repositoryId, ORG))!;
  const input = await readReviewInput([{ host: home.codeHost, repositoryId: pr.repositoryId, repositoryUrl: home.url, number: pr.number, headSha: pr.head }], world.host.scope(ORG));
  const flow = (await world.task()).workflow.flow;
  await world.setWorkflow({ flow: recordQuestionsAnswered(flow, { headSha: head, patchDigest: digest ?? patchDigestOf(input.patchText), at: AT }) });
}

/** `skipped`: the lighter flow skipped planning steps for this task (what P2 writes in `flow.skippedSteps`), so the reviewer's questions are owed. */
async function worldAt(level: "small" | "standard" | "risky", mode: Mode = { patches: true, failing: false, calls: 0 }, skipped = false) {
  const world = await mergeWorld({ codeHost: (model) => patchingHost(model, mode), withoutTier: true });
  await world.seedTracking();
  const flow = { rulesVersion: 1, tier: { level, kinds: ["code_config"], source: "diff", reasons: [], at: AT }, ...(skipped ? { skippedSteps: ["plan_check", "design_review"] } : {}) };
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
    await questioned(world);
    const { run, prepared } = await press(world);
    expect(prepared.tier).toBeUndefined();
    expect((await run()).status).toBe("MERGED");
    expect(mode.calls).toBeGreaterThan(0);
    expect(await tierOf(world)).toMatchObject({ level: "small", source: "merge" });
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

  it("a small change to code is refused until the reviewer's questions are on the record for the current head", async () => {
    const { world } = await worldAt("small", undefined, true);
    const refusal = await rejects((await press(world)).run);
    expect(refusal.message).toBe("A reviewer has not yet answered the security questions for the current version of this change, so it can't be merged yet.");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    // Questions answered for an older head do not count; a push makes them stale.
    await questioned(world, "9".repeat(40));
    expect((await rejects((await press(world)).run)).message).toContain("security questions");
    await questioned(world);
    expect((await (await press(world)).run()).status).toBe("MERGED");
  });

  it("a head that moved while the files were read refuses the merge", async () => {
    const { world, mode } = await worldAt("small");
    await questioned(world);
    const { run } = await press(world);
    mode.afterRead = () => { const pr = world.prs[0]!; pr.model.commit(pr.model.getChangeRequest(String(pr.number)).sourceBranch, { "src/late.ts": "export const late = 1;\n" }); mode.afterRead = undefined; };
    expect((await rejects(run)).message).toBe(M.changedAfterConfirm);
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    // Refused at the tier gate, before anything was claimed: no audit row was staged for a merge that never began.
    expect(await world.auditRows()).toHaveLength(0);
  });

  it("a growth that another writer got in front of is written again until it is on the record", async () => {
    const { world } = await worldAt("small");
    await pushed(world, { "src/auth/session.ts": "export const session = 1;\n" });
    const { run } = await press(world);
    // Another writer moves the record between the gate's read and its write, once.
    let raced = false;
    const store = world.deps.store as unknown as { update: (input: unknown) => Promise<{ applied: boolean }> };
    const original = store.update.bind(store);
    store.update = async (input) => {
      if (!raced) {
        raced = true;
        await original({ key: { pk: `DEVTASK#${TASK_ID}`, sk: "META" }, ops: [{ op: "set", path: ["workflow", "flow", "rulesVersion"], value: 1 }, { op: "set", path: ["workflow", "flow", "moved"], value: 1 }] });
      }
      return original(input);
    };
    await rejects(run);
    store.update = original;
    expect(raced).toBe(true);
    // The growth is on the record in spite of the other writer.
    expect((await world.task()).workflow.flow?.grewAfterBuild).toMatchObject({ to: "risky" });
  });
});

describe("a head that cannot be bound", () => {
  it("is refused: the records of reviews are for a head, and there is none to compare", async () => {
    const { world } = await worldAt("small");
    const pr = world.prs[0]!;
    const home = (await world.host.repository("web", 1, pr.repositoryId, ORG))!;
    // A code host that answers with something that is not a commit id (the fake's own are always 40 hex characters).
    const odd = Object.create(home.codeHost, { pathKind: { value: undefined }, changeRequestStatus: { value: async (...args: Parameters<CodeHost["changeRequestStatus"]>) => ({ ...(await home.codeHost.changeRequestStatus(...args)), headRevision: "not-a-commit" }) } }) as CodeHost;
    const task = await world.task();
    await expect(tierGate(world.deps, task as never, [{ host: odd, repositoryId: pr.repositoryId, repositoryUrl: home.url, number: pr.number, headSha: "not-a-commit" }], world.host.scope(ORG), "small")).rejects.toThrow("which version of the code this is");
  });
});
