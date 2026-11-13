// Fix with agent on the task's page: the button is one verified form bound to the error the page showed and to that one press, the diagnosis is drawn as plain text (a model's words are never a link, a tag or a control),
// and the page's refusals are its fixed words. The page server decides nothing: it hands the verified press to the action.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalPagesServer, type LocalPagesServer } from "../../packages/core/src/core/local-pages/index.js";
import type { PlanDiagnosisView } from "../../packages/core/src/core/local-pages/views.js";
import { TASK, fakeWorld, formBody, formOf, planView, raw, type FakeWorld } from "../support/local-pages-fakes.js";

let server: LocalPagesServer;
let world: FakeWorld;
let base: string;
const pressed: Array<{ taskId: string; requestId: string; errorKey: string }> = [];
const KEY = "a".repeat(64);
const REQUEST = "11111111-1111-4111-8111-111111111111";
/** A key-shaped string built at run time (the public repository refuses a real-looking one in a file). */
const TOKEN = `ghp_${"a1B2".repeat(9)}`;

beforeEach(async () => {
  world = fakeWorld();
  pressed.length = 0;
  server = await createLocalPagesServer({
    data: world.data,
    actions: { ...world.actions, async diagnose(input) { pressed.push(input); return world.actions.next; } },
  });
  base = `/s/${server.sessions.mint().token}`;
});
afterEach(async () => { await server.close(); });

const host = () => new URL(server.origin).host;
const show = (diagnosis: PlanDiagnosisView | undefined) => { world.data.plan = planView({ ...(diagnosis === undefined ? {} : { diagnosis }) }); return raw(server.origin, { path: `${base}/plan/${TASK}`, headers: { host: host() } }); };
const post = (fields: Record<string, string>, path = `/plan/${TASK}/diagnose`) =>
  raw(server.origin, { method: "POST", path: `${base}${path}`, body: formBody(fields), headers: { host: host(), origin: server.origin, "content-type": "application/x-www-form-urlencoded" } });

describe("Fix with agent on the task page", () => {
  it("draws the button as a form bound to the error shown and this press, and hands exactly that press to the action, once", async () => {
    const page = await show({ offer: { requestId: REQUEST, errorKey: KEY } });
    expect(page.body).toContain("Fix with agent");
    expect(page.body).toContain("runs on your own model key, can be wrong, and changes nothing");
    const form = formOf(page.body, "/diagnose");
    expect(form.fields).toMatchObject({ requestId: REQUEST, errorKey: KEY });
    expect(form.fields["ft"]).toMatch(/\S{20,}/u);
    const sent = await post(form.fields);
    expect(sent.status).toBe(303);
    expect(sent.headers["location"]).toContain("n=diagnosing");
    expect(pressed).toEqual([{ taskId: TASK, requestId: REQUEST, errorKey: KEY }]);
    // A second click, or a replay, finds the form spent.
    expect((await post(form.fields)).headers["location"]).toContain("n=form");
    expect(pressed).toHaveLength(1);
  });

  it("refuses a form that was changed after it was drawn, one that is not a press, and a press for another task", async () => {
    const form = formOf((await show({ offer: { requestId: REQUEST, errorKey: KEY } })).body, "/diagnose");
    // Another error than the one the page showed, another press id, or a missing token: the token binds both, and the shape is checked first.
    expect((await post({ ...form.fields, errorKey: "b".repeat(64) })).headers["location"]).toContain("n=form");
    expect((await post({ ...form.fields, requestId: "22222222-2222-4222-8222-222222222222" })).headers["location"]).toContain("n=form");
    expect((await post({ ...form.fields, ft: "" })).headers["location"]).toContain("n=form");
    expect((await post({ ...form.fields, errorKey: "short" })).headers["location"]).toContain("n=invalid");
    expect((await post({ ...form.fields, requestId: "not-a-uuid" })).headers["location"]).toContain("n=invalid");
    expect((await post(form.fields, `/plan/9d2c7a40-1b3e-4f55-8a21-6c7e90b4d2aa/diagnose`)).headers["location"]).toContain("n=form");
    expect(pressed).toEqual([]);
    // The route does not exist for a session that has none, and it takes no GET.
    expect((await raw(server.origin, { path: `${base}/plan/${TASK}/diagnose`, headers: { host: host() } })).status).toBe(404);
    expect((await raw(server.origin, { method: "POST", path: `/s/${"x".repeat(43)}/plan/${TASK}/diagnose`, body: "", headers: { host: host(), origin: server.origin, "content-type": "application/x-www-form-urlencoded" } })).status).toBe(404);
  });

  it("says in the page's fixed words what the action answered", async () => {
    const form = async () => formOf((await show({ offer: { requestId: REQUEST, errorKey: KEY } })).body, "/diagnose");
    world.actions.next = { ok: false, reason: "stale", message: "x" };
    expect((await post((await form()).fields)).headers["location"]).toContain("n=stale");
    world.actions.next = { ok: false, reason: "refused", message: "x" };
    expect((await post((await form()).fields)).headers["location"]).toContain("n=refused");
    world.actions.next = { ok: false, reason: "not_found", message: "x" };
    expect((await post((await form()).fields)).headers["location"]).toContain("n=missing");
  });

  it("draws a diagnosis as plain text: the model's words are escaped and redacted, a link or a tag in them is text, and there is no second button", async () => {
    const page = await show({
      state: "ready", needsCode: true,
      lines: [`Look at <script>alert(1)</script> and [a link](https://examplehost/x) with ${TOKEN}`, "Retry the step with this note: <img src=x onerror=alert(1)>"],
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page.body).not.toContain("<script>");
    expect(page.body).not.toContain("<img src=x");
    expect(page.body).not.toContain(TOKEN);
    expect(page.body).not.toMatch(/<a href="https:\/\/examplehost/u);
    expect(page.body).toContain("it can be wrong, and it has changed nothing");
    expect(page.body).toContain("A deeper look at the repositories is not on this install yet");
    expect(page.body).not.toContain("/diagnose");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(String(page.headers["content-security-policy"])).not.toMatch(/script-src/u);
    expect((await show({ state: "ready", lines: [] })).body).toContain("No suggestion came back for this error.");
  });

  it("says that it is looking, that it failed (with Try again), or why it is not offered, and each is plain words", async () => {
    const waiting = await show({ state: "waiting" });
    expect(waiting.body).toContain("looking into this error");
    expect(waiting.body).not.toContain("/diagnose");
    const failed = await show({ state: "failed", failure: "Your AI provider didn't answer. Try again in a few minutes.", offer: { requestId: REQUEST, errorKey: KEY } });
    expect(failed.body).toContain("Your AI provider didn&#39;t answer.");
    expect(failed.body).toContain("Try again");
    expect(formOf(failed.body, "/diagnose").fields["requestId"]).toBe(REQUEST);
    const why = await show({ why: "Fix with agent runs on your own model key, and none is set up on this computer." });
    expect(why.body).toContain("runs on your own model key");
    expect(why.body).not.toContain("/diagnose");
    // A task that shows no error has no part at all.
    expect((await show(undefined)).body).not.toContain("Fix with agent");
  });
});
