// rovara loop (#357): the Full loop. Requirements, then a design, then a plan, each derived from the one before
// and each approved (and so locked) before the next is written; then code, checks and a pull request. A phase
// can be declared away when the loop starts, and the issue says who declared it.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseComment } from "../../packages/cli/src/loop/commands-parse.js";
import { FULL_LOOP, LoopDefinitionSchema, landingStep, skippablePhases } from "../../packages/cli/src/loop/definitions.js";
import { artifactDigest } from "../../packages/cli/src/loop/exit-checks.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { createLoopHarness, LOOP_ISSUE, LOOP_SESSION, removeAll } from "../support/loop-harness.js";

const dirs: string[] = [];
afterEach(async () => { await removeAll(dirs); });

const REQUIREMENTS = ["## What changes", "A payment that meets a 503 is retried.", "", "## Not changing", "None", "", "## Risks", "Retrying a charge twice.", ""].join("\n");
const DESIGN = ["## How it works", "send() retries with exponential backoff, at most 3 tries.", "", "## Risks", "None", ""].join("\n");
const PLAN = ["## Summary", "Add the retry.", "", "## Changes", "- src/client.ts", "", "## Testing", "- npm test", ""].join("\n");

describe("the Full loop's definition (#357)", () => {
  it("has requirements and design phases that can be declared away, and lands past them", () => {
    expect(skippablePhases(FULL_LOOP)).toEqual(["requirements", "design"]);
    expect(landingStep(FULL_LOOP, "requirements", [])).toBe("requirements");
    expect(landingStep(FULL_LOOP, "requirements", ["requirements"])).toBe("design");
    expect(landingStep(FULL_LOOP, "requirements", ["requirements", "design"])).toBe("plan");
    expect(landingStep(FULL_LOOP, "design", ["design"])).toBe("plan");
  });

  it("refuses a gate that approves no artifact, and a phase that cannot be skipped past", () => {
    const gateless = { ...FULL_LOOP, steps: FULL_LOOP.steps.map((step) => (step.id === "design-review" ? { ...step, artifact: undefined } : step)) };
    expect(LoopDefinitionSchema.safeParse(gateless).success).toBe(false);
    const stuck = { ...FULL_LOOP, edges: FULL_LOOP.edges.filter((edge) => !(edge.from === "design" && edge.on === "skipped")) };
    expect(LoopDefinitionSchema.safeParse(stuck).success).toBe(false);
  });

  it("reads --skip with one phase, several, or with =, and refuses a phase the loop does not have", () => {
    expect(parseComment("/rovara full --skip design Add retries")).toMatchObject({ kind: "start", loop: { name: "full" }, instruction: "Add retries", skip: ["design"] });
    expect(parseComment("/rovara full --skip requirements,design Add retries")).toMatchObject({ skip: ["requirements", "design"] });
    expect(parseComment("/rovara full --skip=design --skip requirements Add retries")).toMatchObject({ skip: ["design", "requirements"], instruction: "Add retries" });
    expect(parseComment("/rovara full --skip plan Add retries")).toEqual({ kind: "invalid", reason: "The full loop can skip `requirements` and `design`, not `plan`." });
    expect(parseComment("/rovara quick --skip design Add retries")).toEqual({ kind: "invalid", reason: "The quick loop has no phases to skip." });
    expect(parseComment("/rovara full --skip design")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("Say what to do") as unknown });
  });
});

describe("the Full loop end to end (#357)", () => {
  it("walks every gate, with a change request at each, each approval locking its document, to one pull request", async () => {
    const h = await createLoopHarness(dirs);
    await h.comment("maya", "/rovara full Retry the payment call on a 503");
    expect(h.label()).toEqual(["rovara:requirements"]);
    const first = h.world.sessions.get(LOOP_SESSION)!.claude.at(-1)!;
    expect(first).toContain("This is the Full loop: requirements, then a design, then a plan");
    expect(first).toContain("Your step now: write the requirements:");
    expect(first).toContain("docs/rovara/42/requirements.md, with these sections as Markdown headings: `## What changes`, `## Not changing`, `## Risks`");

    // Requirements: held to their sections, shown at their gate, changed on request, then approved and locked.
    expect(await h.complete("Wrote the requirements.")).toBe("Not accepted: there is no requirements at docs/rovara/42/requirements.md; write it there");
    await h.write("requirements", "## What changes\nRetries.\n");
    expect(await h.complete("Wrote the requirements.")).toContain("## Not changing, ## Risks");
    await h.write("requirements", REQUIREMENTS);
    expect(await h.complete("Wrote the requirements.")).toContain("Accepted");
    expect(h.label()).toEqual(["rovara:requirements-review"]);
    expect(h.lastPosted()).toContain("<summary>The requirements</summary>");
    expect(h.lastPosted()).toContain("Approve the requirements with `/rovara approve`");
    await h.comment("sam", "Say that a refund is never retried.");
    expect(await h.step()).toBe("requirements");
    expect(await h.read("requirements")).toMatch(/## Review feedback\n\n- @sam \(.+\): Say that a refund is never retried\.\n$/u);
    expect(h.lastReceived()).toContain("@sam asked for changes to the requirements");
    expect(await h.complete("Added refunds.")).toContain("Accepted");
    const requirements = await h.read("requirements");
    await h.comment("maya", "/rovara approve");
    expect(await h.step()).toBe("design");
    expect(h.label()).toEqual(["rovara:design"]);
    expect(h.lastPosted()).toContain("The requirements were approved by @maya, and are locked at `docs/rovara/42/requirements.md`. The design comes next, from it.");
    expect(h.lastReceived()).toContain("@maya approved the requirements. They are locked: do not edit them.");
    expect(h.lastReceived()).toContain("Your step now: write the design:");

    // Design: a claim that changed the approved requirements is refused.
    await h.write("design", DESIGN);
    await h.write("requirements", `${requirements}\nOne more requirement.\n`);
    expect(await h.complete("Designed it.")).toContain("the approved requirements at docs/rovara/42/requirements.md were changed; put them back as approved");
    await h.write("requirements", requirements);
    expect(await h.complete("Designed it.")).toContain("Accepted");
    expect(h.lastPosted()).toContain("<summary>The design</summary>");
    await h.comment("maya", "/rovara changes: cap the backoff at 2 seconds");
    expect(await h.step()).toBe("design");
    expect(await h.read("design")).toContain("cap the backoff at 2 seconds");
    expect(await h.complete("Capped the backoff.")).toContain("Accepted");
    await h.comment("sam", "/rovara approve");
    expect(await h.step()).toBe("plan");
    expect(h.lastPosted()).toContain("The design was approved by @sam, and is locked at `docs/rovara/42/design.md`. The plan comes next, from it.");
    expect(h.lastReceived()).toContain("Derive it from the approved requirements (docs/rovara/42/requirements.md) and design (docs/rovara/42/design.md).");

    // Plan: the same, then code against all three locked documents.
    await h.write("plan", PLAN);
    expect(await h.complete("Planned it.")).toContain("Accepted");
    await h.comment("sam", "List the test file too.");
    expect(await h.step()).toBe("plan");
    expect(await h.complete("Listed it.")).toContain("Accepted");
    await h.comment("maya", "/rovara approve");
    expect(await h.step()).toBe("code");
    expect(h.lastPosted()).toContain("Coding starts");
    const approvals = (await h.state())?.approvals;
    expect(Object.keys(approvals ?? {}).sort()).toEqual(["design", "plan", "requirements"]);
    expect(approvals?.requirements?.digest).toBe(artifactDigest(requirements));
    expect(h.world.pushes).toEqual([]);

    const design = await h.read("design");
    await h.write("design", `${design}\nchanged\n`);
    expect(await h.complete("Coded it.")).toContain("the approved design at docs/rovara/42/design.md was changed");
    await h.write("design", design);
    await h.selfReview();
    expect(await h.complete("Coded it.")).toContain("Accepted");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    expect(h.world.pullRequests).toHaveLength(1);
    expect(h.world.pullRequests[0]!.body).toContain("Approved: the requirements by @maya, the design by @sam, the plan by @maya.");
    // Reports stay in the PR body and outside the candidate that checks/reviews qualified.
    expect(h.world.loopCommits).toEqual([]);
  });

  it("starts past a phase declared away, says who declared it, and the pull request says so", async () => {
    const h = await createLoopHarness(dirs);
    await h.comment("maya", "/rovara full --skip design Retry the payment call on a 503");
    expect(await h.step()).toBe("requirements");
    expect(h.lastPosted()).toContain("@maya declared these phases away: **design**.");
    expect(await h.state()).toMatchObject({ skipped: ["design"] });
    expect(h.world.sessions.get(LOOP_SESSION)!.claude.at(-1)).toContain("These phases were declared away, so there is no document for them: design.");
    await h.write("requirements", REQUIREMENTS);
    await h.complete("Wrote the requirements.");
    await h.comment("maya", "/rovara approve");
    // Past the design, straight to the plan.
    expect(await h.step()).toBe("plan");
    expect(h.label()).toEqual(["rovara:planning"]);
    expect(h.lastPosted()).toContain("The plan comes next, from it.");
    await h.write("plan", PLAN);
    await h.complete("Planned.");
    await h.comment("maya", "/rovara approve");
    await h.selfReview();
    await h.complete("Coded.");
    await h.runOwnSteps();
    expect(h.world.pullRequests[0]!.body).toContain("Approved: the requirements by @maya, the plan by @maya. Declared away: design.");

    // Both phases declared away: it starts at the plan.
    const both = await createLoopHarness(dirs);
    await both.comment("maya", "/rovara full --skip requirements,design Retry the payment call on a 503");
    expect(await both.step()).toBe("plan");
    expect(both.label()).toEqual(["rovara:planning"]);
  });
});

describe("rovara loop check on a Full item (#357)", () => {
  it("names each document's state: declared away, missing sections, written but unlocked, locked, changed", async () => {
    const h = await createLoopHarness(dirs);
    const wt = join(h.root, "wt");
    const write = async (name: string, text: string) => {
      await mkdir(join(wt, "docs", "rovara", "42"), { recursive: true });
      await writeFile(join(wt, "docs", "rovara", "42", name), text);
    };
    await write("requirements.md", REQUIREMENTS);
    await write("design.md", `${DESIGN}changed after approval\n`);
    await write("plan.md", "## Summary\nx\n");
    const store = new LoopStore(join(h.root, "home", ".rovara", "loop"));
    const base = {
      version: 1 as const, repo: "acme/payments", issue: LOOP_ISSUE, loop: "full", step: "plan", startedBy: "maya", instruction: "x",
      startedAt: "2026-10-13T00:00:00.000Z", stepEnteredAt: "2026-10-13T00:00:00.000Z", worktree: { path: wt, branch: "rovara/42" },
      approvals: { requirements: { digest: artifactDigest(REQUIREMENTS), by: "maya", at: "2026-10-13T01:00:00.000Z" }, design: { digest: artifactDigest(DESIGN), by: "sam", at: "2026-10-13T02:00:00.000Z" } },
    };
    await store.saveItem(base);
    const out: string[] = [];
    const run = (argv: string[]) => executeCli(argv, { environments: { home: join(h.root, "home") }, loop: { exec: h.world.exec }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: () => undefined } });
    expect(await run(["loop", "check", "42", "--repo", "acme/payments"])).toBe(0);
    const text = out.join("");
    expect(text).toContain("  requirements: locked, approved by @maya at 2026-10-13T01:00:00.000Z");
    expect(text).toContain("  design: CHANGED since @sam approved it at 2026-10-13T02:00:00.000Z (docs/rovara/42/design.md)");
    expect(text).toContain("  plan: missing sections ## Changes, ## Testing (docs/rovara/42/plan.md)");
    await write("plan.md", PLAN);
    await store.saveItem({ ...base, skipped: ["design"], approvals: { requirements: base.approvals.requirements } });
    out.length = 0;
    await run(["loop", "check", "42", "--repo", "acme/payments"]);
    expect(out.join("")).toContain("  design: declared away by @maya");
    expect(out.join("")).toContain("  plan: written, not approved yet, so not locked (docs/rovara/42/plan.md)");
  });
});
