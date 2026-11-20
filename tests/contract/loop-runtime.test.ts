// rovara loop (#355): the loop's decisions, with no I/O: what a comment asks for, and what each event does
// to a work item on the Do loop.
import { describe, expect, it } from "vitest";
import { parseComment } from "../../packages/cli/src/loop/commands-parse.js";
import { DO_LOOP, LoopDefinitionSchema, nextStep } from "../../packages/cli/src/loop/definitions.js";
import { decide, type LoopEvent } from "../../packages/cli/src/loop/runtime.js";
import type { WorkItemState } from "../../packages/cli/src/loop/state.js";

const ITEM = { repo: "acme/payments", issue: 42 };
const AT = "2026-10-12T12:00:00.000Z";
const start: LoopEvent = { kind: "start", loop: DO_LOOP, instruction: "Fix the flaky retry test", author: "maya", at: AT };
const started = () => decide(DO_LOOP, undefined, start, ITEM).state!;
const at = (state: WorkItemState, step: string): WorkItemState => ({ ...state, step });

describe("a loop is data (#355)", () => {
  it("validates a definition, and refuses one whose edges name a step it does not declare", () => {
    expect(nextStep(DO_LOOP, "work", "done")).toBe("waiting");
    expect(nextStep(DO_LOOP, "waiting", "reply")).toBe("work");
    expect(nextStep(DO_LOOP, "waiting", "closed")).toBe("ended");
    expect(nextStep(DO_LOOP, "ended", "reply")).toBeUndefined();
    const broken = LoopDefinitionSchema.safeParse({ ...DO_LOOP, edges: [...DO_LOOP.edges, { from: "work", to: "nowhere", on: "done" }] });
    expect(broken.success).toBe(false);
    expect(LoopDefinitionSchema.safeParse({ ...DO_LOOP, start: "missing" }).success).toBe(false);
  });
});

describe("what a comment asks for (#355)", () => {

  it("says what is wrong with a command it cannot run, and treats anything else as a reply", () => {
    expect(parseComment("/rovara do")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("Say what to do after `/rovara do`") as unknown });
    expect(parseComment("/rovara deploy now")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("is not a command I know") as unknown });
    expect(parseComment("Looks good, also rename the helper")).toEqual({ kind: "reply", text: "Looks good, also rename the helper" });
    // Only the first line can be a command.
    expect(parseComment("thanks!\n/rovara stop")).toMatchObject({ kind: "reply" });
  });
});

describe("the Do loop's decisions (#355)", () => {

  it("does not start a second loop on an issue that has one running", () => {
    const state = started();
    const decision = decide(DO_LOOP, state, start, ITEM);
    expect(decision.state).toBe(state);
    expect(decision.effects).toEqual([{ kind: "comment", body: expect.stringContaining("A loop is already running") as unknown }]);
  });

  it("accepts the agent's claim only when its exit checks pass, posts the summary, and waits for the person", () => {
    const claim = (summary: string, failures: string[] = []): LoopEvent => ({ kind: "claim", claimId: "c1", summary, failures, at: AT });
    // The daemon runs the exit checks (exit-checks.ts); the runtime refuses with every failure, joined.
    expect(decide(DO_LOOP, started(), claim("  ", ["give a summary of what you did; it is posted on the issue", "another"]), ITEM).effects).toEqual([{ kind: "verdict", claimId: "c1", outcome: "block", reason: "give a summary of what you did; it is posted on the issue; another" }]);
    const done = decide(DO_LOOP, started(), claim("Fixed the retry test by waiting on the mock."), ITEM);
    expect(done.state).toMatchObject({ step: "waiting", summary: "Fixed the retry test by waiting on the mock." });
    expect(done.effects).toEqual([
      { kind: "label", label: "waiting" },
      { kind: "comment", body: "Fixed the retry test by waiting on the mock.\n\n---\nReply to continue, or close the issue to finish." },
      { kind: "verdict", claimId: "c1", outcome: "pass", reason: expect.stringContaining("Stop here and wait") as unknown },
    ]);
    // Not the agent's turn while it waits for the person.
    expect(decide(DO_LOOP, done.state, claim("again"), ITEM).effects[0]).toMatchObject({ outcome: "block", reason: "step waiting is not yours: it is waiting for a person" });
  });

  it("ends on a closed issue or a stop, ending the session, and ignores everything after", () => {
    const closed = decide(DO_LOOP, started(), { kind: "closed", at: AT }, ITEM);
    expect(closed.state?.step).toBe("ended");
    expect(closed.effects).toEqual([{ kind: "label", label: undefined }, { kind: "end-session" }]);
    const stopped = decide(DO_LOOP, at(started(), "waiting"), { kind: "stop", author: "maya", at: AT }, ITEM);
    expect(stopped.effects.map((effect) => effect.kind)).toEqual(["label", "end-session", "comment"]);
    expect(decide(DO_LOOP, closed.state, { kind: "reply", text: "one more thing", author: "maya", at: AT }, ITEM).effects).toEqual([]);
    expect(decide(DO_LOOP, closed.state, { kind: "claim", claimId: "c2", summary: "done", failures: [], at: AT }, ITEM).effects[0]).toMatchObject({ outcome: "block", reason: "this loop has ended; there is nothing to complete" });
  });
});
