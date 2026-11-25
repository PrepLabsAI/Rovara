// TASK-TAKEOVER PR A: every starter of a PAID step either carries the person whose press made it due (so the step is charged to the presser), or is on the list of steps nobody pressed. A new `acceptStep` caller that is on
// neither list fails here, so a press cannot silently fall back to the fixed order.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const SRC = join(ROOT, "packages/broker/src");
const walk = (directory: string): string[] => readdirSync(directory).flatMap((name) => (statSync(join(directory, name)).isDirectory() ? walk(join(directory, name)) : name.endsWith(".ts") ? [join(directory, name)] : []));
const callers = (): string[] => walk(SRC).filter((file) => /\bacceptStep(?:WithNotes)?\(/u.test(readFileSync(file, "utf8")) && !file.endsWith("task-flow/stage-machine.ts")).map((file) => relative(SRC, file)).sort();

/** Files whose paid steps a person's press starts: each names the presser (`by`, or `byOf(row)` for a step run from a dispatch row). */
const PRESSED = ["core/build-step/publish.ts", "core/build-step/start.ts", "core/task-flow/continue.ts", "core/task-flow/manual-publication.ts", "core-host/parity-task-actions.ts"];
/** Files whose paid steps the system starts after something else finished (nobody pressed; the dispatch row's own `by`, when it has one, is read by `acceptStep`). */
const SYSTEM = ["aws/core-application-e2e.ts", "core/build-step/maintain.ts", "core/design-review/resolve-run.ts", "core/design-review/round-start.ts", "core/plan/check.ts", "core/pr-feedback/review.ts"];

describe("who starts a paid step", () => {
  it("every acceptStep caller is a pressed starter or a system one, and a pressed starter names the presser", () => {
    expect(callers()).toEqual([...PRESSED, ...SYSTEM].sort());
    for (const file of PRESSED) expect(readFileSync(join(SRC, file), "utf8"), file).toMatch(/\bby\b|byOf\(row\)/u);
  });

  it("a session's Retry, a session's or the page's Answers and the page's Retry name the presser (the callers of retryBlockedStep and answerUnderstandQuestions are the pressed ones or the named system ones)", () => {
    const calling = (pattern: RegExp): string[] => walk(SRC).filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => relative(SRC, file)).sort();
    // retryBlockedStep: pressed (a person's Retry), or the system's own (the automatic resume, the service wrapper a host injects, the laptop's own route).
    expect(calling(/\bretryBlockedStep\(/u).filter((file) => !file.endsWith("task-flow/retry.ts"))).toEqual(["core-host/parity-task-actions.ts", "core/setup-agent/auto-resume.ts", "local/app/host.ts", "local/app/page-data.ts", "services/session-actions.ts"]);
    for (const file of ["core-host/parity-task-actions.ts", "local/app/host.ts", "local/app/page-data.ts"]) expect(readFileSync(join(SRC, file), "utf8"), file).toMatch(/retryBlockedStep\([^)]*(?:\bby\b|personId)[^)]*\)/u);
    // The session control hands the principal to the host's retry; the host's retry hands it on.
    expect(readFileSync(join(SRC, "core/sessions/control.ts"), "utf8")).toContain("retryWorkflow(session.subject.taskId, input.requestId, principal.personId)");
    // answerUnderstandQuestions: both callers name the person.
    expect(calling(/\banswerUnderstandQuestions\(/u).filter((file) => !file.endsWith("local/app/answers.ts"))).toEqual(["local/app/page-data.ts", "local/app/session-routes.ts"]);
    for (const file of ["local/app/page-data.ts", "local/app/session-routes.ts"]) expect(readFileSync(join(SRC, file), "utf8"), file).toMatch(/answerUnderstandQuestions\([\s\S]{0,400}personId/u);
    expect(readFileSync(join(SRC, "local/app/answers.ts"), "utf8")).toContain("input.by.personId");
  });

  it("the owner moves that make a step due write the presser on its dispatch row", () => {
    for (const file of ["core/task-flow/send-back.ts", "core/task-flow/review-findings.ts", "core/task-flow/answer-request.ts", "core/pr-feedback/decide.ts", "services/decisions.ts"]) {
      expect(readFileSync(join(SRC, file), "utf8"), file).toContain("pressedRowItem(");
    }
    expect(readFileSync(join(SRC, "core/task-flow/retry.ts"), "utf8")).toMatch(/pressedRowItem\(|, by\)/u);
    expect(readFileSync(join(SRC, "core/design-review/choice-subject.ts"), "utf8")).toContain("presser");
  });
});
