// Lane L4-PRP (design pr-redesign.md B7): the "ready for review" line says the pull request's verdict heading, the description's own words, on the task's timeline, in the chat and in the ticket. Driven through the real
// tracking pass over the in-memory store and the fake host. The words never stop a pull request from being marked ready.
import { describe, expect, it } from "vitest";
import { CodeMilestoneSchema, type ProofHoldFacts, type TestProof, type TestProofItem } from "../../packages/contracts/src/index.js";
import { VERDICT_READ_MAX_MS, trackPullRequest, type MergeTrackingDependencies, type ProofHoldSource } from "../../packages/broker/src/core/merge/index.js";
import { ticketUpdateText } from "../../packages/broker/src/core/ticket-updates/handler.js";
import { TASK_ID, mergeWorld } from "../support/merge-world.js";

const DIGEST = "d".repeat(64);
const item = (verdict: TestProofItem["verdict"], reason: TestProofItem["reason"]): TestProofItem => ({ checkId: "unit", label: "unit", granularity: "check", verdict, reason });
const proof = (items: TestProofItem[]): TestProof => ({ schemaVersion: 1, candidateDigest: DIGEST, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items, durationMs: 1 });
const PROVEN: ProofHoldFacts = { proof: proof([item("proves_change", "assertion_failed_on_old")]) };
const holdSource: ProofHoldSource = { mode: () => "hold", facts: async () => PROVEN };
const HEADING = "Verified · Low risk · nothing extra to check";

async function world(verdict: MergeTrackingDependencies["verdict"]) {
  const w = await mergeWorld();
  const pr = w.prs[0]!;
  pr.model.getChangeRequest(String(pr.number)).draft = true;
  const tracking: MergeTrackingDependencies = { ...w.tracking, proofHold: holdSource, ...(verdict === undefined ? {} : { verdict }) };
  const ready = () => w.milestones.written.filter((milestone) => milestone.kind === "pr_ready");
  return { w, pr, tracking, ready };
}

describe("the ready line says the verdict", () => {
  // Mutant R1: the heading is not put in the line, or not in the milestone's verdict field.
  it("with a verdict: the line and the milestone carry its heading, for the pull request that was marked ready", async () => {
    const asked: Array<{ repositoryId: string; number: number; headSha: string }> = [];
    const { w, pr, tracking, ready } = await world(async (input) => { asked.push({ repositoryId: input.repositoryId, number: input.number, headSha: input.headSha }); return { resultKind: "verified", heading: HEADING, body: [] }; });
    await trackPullRequest(tracking, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
    expect(ready()).toHaveLength(1);
    expect(ready()[0]!.text).toBe(`Rovara marked app pull request ${String(pr.number)} ready for review. ${HEADING}.`);
    expect(ready()[0]!.verdict).toBe(HEADING);
    expect(asked).toEqual([{ repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head }]);
    expect(CodeMilestoneSchema.safeParse(ready()[0]).success).toBe(true);
    void w;
  });
  it("a source that fails, or says nothing, leaves the line as it was and the pull request is still marked ready", async () => {
    for (const verdict of [async () => { throw new Error("down"); }, async () => undefined] as const) {
      const { tracking, ready, pr } = await world(verdict);
      await trackPullRequest(tracking, TASK_ID);
      expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
      expect(ready()[0]!.text).toBe(`Rovara marked app pull request ${String(pr.number)} ready for review.`);
    }
  });
  // Mutant R2: no time limit (a slow source holds the pass).
  it("a source that takes longer than the limit is not waited for", async () => {
    const { tracking, ready, pr } = await world(() => new Promise(() => undefined));
    const started = Date.now();
    await trackPullRequest(tracking, TASK_ID);
    expect(Date.now() - started).toBeLessThan(VERDICT_READ_MAX_MS + 3_000);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
    expect(ready()[0]!.text).toBe(`Rovara marked app pull request ${String(pr.number)} ready for review.`);
  }, 15_000);
});

describe("the ticket says the verdict of a ready pull request only", () => {
  const input = { title: "Add a retry", pullRequests: ["https://git.example.test/acme/web/pull/7"], verdict: "Code failed checks · High risk · 4 things to check (treated as high)" };
  it("a pr_opened update has a Result line, made inert, before the link", () => {
    const text = ticketUpdateText({ moment: "pr_opened", ...input });
    const lines = text.split("\n");
    expect(lines[1]).toBe("Result: Code failed checks · High risk · 4 things to check (treated as high).");
    expect(lines.at(-1)).toBe("Pull request: https://git.example.test/acme/web/pull/7");
  });
  it("hostile characters in the words are taken out, never passed on", () => {
    const text = ticketUpdateText({ moment: "pr_opened", title: "t", verdict: "Verified <b>x</b> @everyone [a](b) `c`" });
    expect(text).not.toMatch(/[<>@[\]`]/u);
  });
  it("any other moment, and a pr_opened without a verdict, say nothing about it", () => {
    expect(ticketUpdateText({ moment: "merged", ...input })).not.toContain("Result:");
    expect(ticketUpdateText({ moment: "pr_opened", title: input.title, pullRequests: input.pullRequests })).not.toContain("Result:");
  });
});
