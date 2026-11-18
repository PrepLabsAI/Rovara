// Lead 4 J2: the Slack service's client for `POST /v1/service/answers` (thread-api.ts `askAnswer`): the body is exactly the id and the words, the answer is read strictly, a control plane that does not serve answers
// for the thread is a decline, and any other failure throws (the door then says its fixed words).
import { describe, expect, it } from "vitest";
import { ANSWER_WORDS, SLACK_ANSWER_SERVICE_PATH, type SlackAnswerResult } from "@agentx/contracts";
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
  it("posts exactly the request id and the question to the answer route and reads the answer", async () => {
    const w = api(() => ({ status: 200, body: ANSWERED }));
    expect(await w.api.askAnswer!({ requestId: REQUEST, question: "How long do refunds last?" })).toEqual(ANSWERED);
    expect(w.seen).toEqual([{ url: `https://control.example/v1${SLACK_ANSWER_SERVICE_PATH}`, method: "POST", body: { requestId: REQUEST, question: "How long do refunds last?" } }]);
  });

  it("refuses to send anything else (a project, a company, a person, a thread)", async () => {
    const w = api(() => ({ status: 200, body: ANSWERED }));
    await expect(w.api.askAnswer!({ requestId: REQUEST, question: "q", project: "beta" } as never)).rejects.toThrow();
    await expect(w.api.askAnswer!({ requestId: "not-a-uuid", question: "q" })).rejects.toThrow();
    expect(w.seen).toEqual([]);
  });

  it("reads the answer strictly: a shape the contract does not know is an error, not an answer", async () => {
    const odd = api(() => ({ status: 200, body: { status: "answered", answer: { ...ANSWERED.status === "answered" ? ANSWERED.answer : {}, outcome: "bogus" } } }));
    await expect(odd.api.askAnswer!({ requestId: REQUEST, question: "q" })).rejects.toThrow();
    const extra = api(() => ({ status: 200, body: { ...ANSWERED, project: "beta" } }));
    await expect(extra.api.askAnswer!({ requestId: REQUEST, question: "q" })).rejects.toThrow();
  });

  it.each([[403, "FORBIDDEN"], [404, "NOT_FOUND"]])("a %s %s from the control plane is a decline (the request goes the old way)", async (status, code) => {
    const w = api(() => ({ status, body: { error: { code, message: "Slack channel is not bound to a project" } } }));
    expect(await w.api.askAnswer!({ requestId: REQUEST, question: "q" })).toEqual({ status: "declined", reason: "not_available" });
  });

  it.each([[500, "RUNTIME_UNAVAILABLE"], [429, "TOO_MANY_REQUESTS"], [400, "CONFIG_INVALID"]])("a %s %s is thrown, never a decline", async (status, code) => {
    const w = api(() => ({ status, body: { error: { code, message: "nope" } } }));
    await expect(w.api.askAnswer!({ requestId: REQUEST, question: "q" })).rejects.toThrow(code);
  });
});
