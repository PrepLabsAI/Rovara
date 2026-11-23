import { describe, expect, it } from "vitest";
import { WikiAnswerRecordWriteSchema, AnswerTaskCitationSchema } from "@agentx/contracts";
import { checkAnswer } from "../../packages/broker/src/core/answers/verify.js";
import { parseTurn, type FinalAnswer } from "../../packages/broker/src/core/answers/protocol.js";
import { HEAD, REFUND_TS, goodSentence, refundCite } from "../support/answer-world.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const quote = "Status: IMPLEMENT / RUNNING";
const task = { taskId: TASK, shown: quote };
const sentence = (text = "The task is running.", cites: FinalAnswer["sentences"][number]["cites"] = [{ kind: "task_state", quote }]) => ({ text, cites });
const check = (sentences: FinalAnswer["sentences"], shown: typeof task | null = task) => checkAnswer({ final: { sentences, not_confirmed: [], points_at_change: false, wiki_wrong: [] }, task: shown ?? undefined, heads: new Map([["web", HEAD]]), read: async () => REFUND_TS });

describe("task-state citation evidence", () => {
  it("accepts the documented model shape and the original code shape", async () => {
    expect(parseTurn(JSON.stringify({ action: "answer", sentences: [sentence()] })).kind).toBe("final");
    expect((await check([goodSentence])).sources).toEqual([{ repo: "web", path: "src/refund.ts", line: 3, commit: HEAD, quote: refundCite.quote }]);
    expect((await check([sentence()])).kept).toHaveLength(1);
  });
  it("refuses missing task data and task quotes that were never shown", async () => {
    expect((await check([sentence()], null)).kept).toEqual([]);
    expect((await check([sentence()], { taskId: TASK, shown: "Other status data entirely" })).kept).toEqual([]);
  });
  it("refuses mixed evidence, unquoted numbers, short quotes, and secret text removed from context", async () => {
    for (const row of [sentence("Running.", [{ kind: "task_state", quote }, refundCite]), sentence("It has 500 steps."), sentence("Running.", [{ kind: "task_state", quote: "Status:" }]), sentence("Running.", [{ kind: "task_state", quote: "HIDDEN-END-OF-REQUEST" }])]) expect((await check([row])).kept).toEqual([]);
  });
  it("deduplicates task sources and shares the source limit across citation kinds", async () => {
    const repeated = await check([sentence("The task is running.", [{ kind: "task_state", quote }, { kind: "task_state", quote }, { kind: "task_state", quote }]), sentence(), goodSentence]);
    expect(repeated.sources).toHaveLength(2); expect(repeated.kept.map((row) => row.sources)).toEqual([[0], [0], [1]]);
    const rows = Array.from({ length: 10 }, (_, n) => sentence("The task is running.", [{ kind: "task_state", quote: `The task status entry ${n} is running.` }]));
    const checked = await check([goodSentence, ...rows], { taskId: TASK, shown: rows.map((row) => row.cites[0]!.quote).join("\n") });
    expect(checked.sources).toHaveLength(8); expect(checked.kept).toHaveLength(8); expect(checked.dropped).toEqual(["over_source_limit", "over_source_limit", "over_source_limit"]);
  });
});


it("keeps the published task-state source schema strict, bounded and compatible with documented input", () => {
  const source = { n: 1, kind: "task_state", taskId: TASK, quote };
  expect(AnswerTaskCitationSchema.parse(source)).toEqual(source);
  for (const bad of [{ ...source, quote: "short" }, { ...source, quote: "x".repeat(601) }, { ...source, taskId: "bad" }, { ...source, repo: "forged" }, { ...source, n: 9 }, { ...source, n: 0 }, { ...source, kind: "forged" }]) expect(AnswerTaskCitationSchema.safeParse(bad).success).toBe(false);
});


it("keeps new fields on the existing answer record strict and accepts old records", () => {
  const old = { answerId: "answer-test", askedBy: "ada", channel: "web", question: "Status?", answer: "Running.", outcome: "answered", sources: [], pagesRead: [] };
  expect(WikiAnswerRecordWriteSchema.parse(old)).toEqual(old);
  const current = { ...old, taskId: TASK, threadId: "thread-a", taskSources: [{ n: 1, kind: "task_state", taskId: TASK, quote }], codeSourceNumbers: [] };
  expect(WikiAnswerRecordWriteSchema.parse(current)).toEqual(current);
  for (const bad of [{ ...current, taskId: "bad" }, { ...current, threadId: "bad/thread" }, { ...current, codeSourceNumbers: [9] }, { ...current, taskSources: [{ n: 0, kind: "task_state", taskId: TASK, quote }] }, { ...current, taskSources: [{ n: 1, kind: "forged", taskId: TASK, quote }] }, { ...current, taskSources: [{ n: 1, kind: "task_state", taskId: "bad", quote }] }, { ...current, taskSources: [{ n: 1, kind: "task_state", taskId: TASK, quote: "short" }] }, { ...current, taskSources: Array.from({ length: 9 }, () => current.taskSources[0]) }]) expect(WikiAnswerRecordWriteSchema.safeParse(bad).success).toBe(false);
});

it("the documented task citation input rejects additional model-supplied source fields", () => {
  for (const extra of [{ bogus: "forged" }, { taskId: "22222222-2222-4222-8222-222222222222" }]) expect(parseTurn(JSON.stringify({ action: "answer", sentences: [sentence("The task is running.", [{ kind: "task_state", quote, ...extra }])] })).kind).toBe("bad");
});
