// Lead 4 J2: the Slack service's client for `POST /v1/service/answers` (thread-api.ts `askAnswer`): the body is exactly the id and the words, the answer is read strictly, a control plane that does not serve answers
// for the thread is a decline, and any other failure throws (the door then says its fixed words).
import { describe, expect, it } from "vitest";
import { ANSWER_WORDS, type SlackAnswerResult } from "@agentx/contracts";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { withSlackThreadRoutes } from "../../packages/slack-service/src/slack-thread-api.js";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const ANSWERED: SlackAnswerResult = {
  status: "answered", attach: "framed",
  answer: { answerId: "a" + "b".repeat(30), threadId: "t", outcome: "answered", text: "Refunds last 30 days. [1]", unconfirmed: [], sources: [], wikiPages: [], action: { kind: "quick_task", label: ANSWER_WORDS.taskButton, title: "Change refunds" } },
};

function api(respond: (request: { url: string; method: string; body: unknown }) => { status: number; body: unknown }) {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const signedFetch: typeof fetch = async (input, init) => {
    const request = { url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined };
    seen.push(request);
    const answer = respond(request);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  return { api: withSlackThreadRoutes(createThreadApi({ controlPlaneUrl: "https://control.example/v1", signedFetch }), { controlPlaneUrl: "https://control.example/v1", signedFetch }), seen };
}

describe("the Slack service's answer client", () => {

  it("reads the answer strictly: a shape the contract does not know is an error, not an answer", async () => {
    const odd = api(() => ({ status: 200, body: { status: "answered", answer: { ...ANSWERED.status === "answered" ? ANSWERED.answer : {}, outcome: "bogus" } } }));
    await expect(odd.api.askAnswer!({ requestId: REQUEST, question: "q" })).rejects.toThrow();
    const extra = api(() => ({ status: 200, body: { ...ANSWERED, project: "beta" } }));
    await expect(extra.api.askAnswer!({ requestId: REQUEST, question: "q" })).rejects.toThrow();
  });

  it.each([[403, "FORBIDDEN"]])("a %s %s from the control plane is a decline (the request goes the old way)", async (status, code) => {
    const w = api(() => ({ status, body: { error: { code, message: "Slack channel is not bound to a project" } } }));
    expect(await w.api.askAnswer!({ requestId: REQUEST, question: "q" })).toEqual({ status: "declined", reason: "not_available" });
  });

});
