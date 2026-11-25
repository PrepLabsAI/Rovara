// D1-1: the core's own answer to a developer task route for a task it owns (core-host/task-route-answer.ts). The words are what the old developer route said; the owner of the answer is the core.
// Cloud rewrites two phrases of Code's sentences by regex (Cloud's task-words.ts) and matches the refusal sentences exactly; the last test applies those regexes.
import { describe, expect, it } from "vitest";
import type { BrokerRequest, BrokerResponse } from "../../packages/broker/src/handler.js";
import { NOT_ON_THE_CORE_YET } from "../../packages/broker/src/core-host/dev-routes.js";
import { answerTaskRoute, missingTaskAnswer, missingTaskWords } from "../../packages/broker/src/core-host/task-route-answer.js";

const TASK = "0a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d";
const reply = (statusCode: number, body: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const request = (method: string, suffix = ""): BrokerRequest => ({ method, path: `/v1/dev/tasks/${TASK}${suffix}`, headers: {}, requestId: "req-1" });
const MISSING = { error: { code: "TASK_NOT_FOUND", message: `no task ${TASK} of yours` } };
const bodyOf = (answer: BrokerResponse): unknown => JSON.parse(answer.body);

describe("the core's answer to a developer task route", () => {
  it("says the missing task's words, and never echoes a malformed id", () => {
    expect(missingTaskWords(TASK)).toBe(`no task ${TASK} of yours`);
    expect(missingTaskWords("<b>x</b>")).toBe("that is not a task ID of yours");
    expect(missingTaskAnswer(TASK)).toMatchObject({ statusCode: 404 });
    expect(bodyOf(missingTaskAnswer(TASK))).toEqual(MISSING);
  });

  it("turns the core's 404 and 401 into a missing task's answer (another company, a colleague, no company, a caller the mapping does not know)", async () => {
    for (const status of [404, 401]) {
      const answer = await answerTaskRoute(async () => reply(status, { error: { code: status === 401 ? "UNAUTHENTICATED" : "TASK_NOT_FOUND", message: "anything else the core said" } }), request("POST", "/cancel"), {}, TASK);
      expect({ status: answer.statusCode, body: bodyOf(answer) }).toEqual({ status: 404, body: MISSING });
    }
  });

  it("passes every other answer on untouched (a 200 view, a 400 refusal, a 403)", async () => {
    for (const [status, body] of [[200, { task: { taskId: TASK } }], [400, { error: { code: "CONFIG_INVALID", message: "requestId: required" } }], [403, { error: { code: "FORBIDDEN", message: "Only the owner can stop it." } }]] as const) {
      const given = reply(status, body);
      expect(await answerTaskRoute(async () => given, request("POST", "/cancel"), {}, TASK)).toBe(given);
    }
  });

  it("a route the core does not serve: not on the core yet for someone its task read shows the task to, a missing task's answer for anyone else", async () => {
    const reads: string[] = [];
    const serves = (read: BrokerResponse | undefined) => async (asked: BrokerRequest) => {
      if (asked.method === "GET" && asked.path === `/v1/dev/tasks/${TASK}`) { reads.push(asked.requestId ?? "none"); return read; }
      return undefined;
    };
    const shown = await answerTaskRoute(serves(reply(200, { task: {} })), request("POST", "/workflow/review"), {}, TASK);
    expect({ status: shown.statusCode, body: bodyOf(shown) }).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } } });
    expect(reads).toEqual(["req-1"]);
    for (const read of [reply(404, {}), reply(401, {}), undefined, reply(500, {})]) {
      const hidden = await answerTaskRoute(serves(read), request("POST", "/workflow/review"), {}, TASK);
      expect(bodyOf(hidden)).toEqual(MISSING);
    }
    // A GET of the task itself that the core does not serve is a missing task's answer, with no second read.
    reads.length = 0;
    expect(bodyOf(await answerTaskRoute(async (asked) => { reads.push(asked.path); return undefined; }, request("GET"), {}, TASK))).toEqual(MISSING);
    expect(reads, "the route is asked once, for the GET itself").toEqual([`/v1/dev/tasks/${TASK}`]);
  });

  it("Cloud's sentence rewrites (task-words.ts: ' (in the task's Slack thread or on the task page)' and ' in the thread.') change none of these sentences, and the sentences Cloud matches are byte-identical", () => {
    const RULES: ReadonlyArray<readonly [RegExp, string]> = [[/ \(in the task's Slack thread or on the task page\)/gu, " (on the task page)"], [/ in the thread\./gu, " on the task page."]];
    const sentences = [missingTaskWords(TASK), missingTaskWords("not-an-id"), NOT_ON_THE_CORE_YET];
    for (const sentence of sentences) expect(RULES.reduce((words, [pattern, replacement]) => words.replace(pattern, replacement), sentence), sentence).toBe(sentence);
    // The exact strings Cloud matches (Cloud's CORE_NOT_YET and CODE_NOT_YET constants) and Code's old route said.
    expect(NOT_ON_THE_CORE_YET).toBe("That is not on the core engine on this install yet.");
    expect(missingTaskWords(TASK)).toBe(`no task ${TASK} of yours`);
    expect(missingTaskWords("x")).toBe("that is not a task ID of yours");
  });
});
