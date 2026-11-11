// Lane L8: the local review pages. The security cases come first: they are the reason the pages are safe to leave running on a developer's machine.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalOwnerApprovers, LOCAL_SESSION_METHOD } from "../../packages/broker/src/ports/policy-defaults.js";
import { createLocalPagesServer, MAX_BODY_BYTES, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { DESIGN_OFFER, OFFER, OTHER_TASK, TASK, fakeWorld, formBody, formOf, raw, type FakeWorld } from "../support/local-pages-fakes.js";

let server: LocalPagesServer;
let world: FakeWorld;
let token: string;
let base: string;

beforeEach(async () => {
  world = fakeWorld();
  server = await createLocalPagesServer({ data: world.data, actions: world.actions });
  token = server.sessions.mint().token;
  base = `/s/${token}`;
});
afterEach(async () => { await server.close(); });

const host = () => new URL(server.origin).host;
const get = (path: string, headers: Record<string, string> = {}) => raw(server.origin, { path, headers: { host: host(), ...headers } });
/** The form as drawn now: each form answers once, so a test that submits twice draws it twice. */
const formNow = async (path: string, suffix: string) => formOf((await get(`${base}${path}`)).body, suffix);
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  raw(server.origin, { method: "POST", path, body: formBody(fields), headers: { host: host(), origin: server.origin, "content-type": "application/x-www-form-urlencoded", ...headers } });

describe("who may reach the pages", () => {
  it("listens on 127.0.0.1 only", () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("answers a page with a good token, and a wrong, missing or malformed token exactly like a path that does not exist", async () => {
    expect((await get(`${base}/`)).status).toBe(200);
    const unknown = await get("/nothing/here");
    for (const path of [`/s/${"A".repeat(43)}/`, "/s/short/", "/", "/s/", `/s/${token}x/`]) {
      const reply = await get(path);
      expect(reply.status, path).toBe(404);
      expect(reply.body).toBe(unknown.body);
    }
  });

  it("refuses a request whose Host is not this listener (DNS rebinding), before it looks at the token", async () => {
    const port = new URL(server.origin).port;
    for (const name of [`attacker.example:${port}`, `localhost:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `[::1]:${port}`, `127.0.0.1.attacker.example:${port}`]) {
      const reply = await raw(server.origin, { path: `${base}/`, headers: { host: name } });
      expect(reply.status, name).toBe(421);
      expect(reply.body).not.toContain("Waiting for you");
    }
  });

  it("refuses a request from another site or another port, whatever the token", async () => {
    expect((await get(`${base}/`, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(`${base}/`, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await get(`${base}/`, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await get(`${base}/`, { "sec-fetch-site": "none" })).status).toBe(200);
    expect((await get(`${base}/`, { origin: "http://127.0.0.1:1" })).status).toBe(403);
    expect((await get(`${base}/`, { referer: "http://127.0.0.1:1/x" })).status).toBe(403);
    expect((await get(`${base}/`, { referer: "not a url" })).status).toBe(403);
    expect((await get(`${base}/`, { referer: `${server.origin}/other` })).status).toBe(200);
  });

  it("sends no CORS header and the same hardening headers on every answer", async () => {
    for (const reply of [await get(`${base}/`), await get("/nothing"), await get(`${base}/`, { origin: "http://evil.example" })]) {
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["referrer-policy"]).toBe("same-origin");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.headers["x-frame-options"]).toBe("DENY");
    }
  });

  it("allows GET, HEAD and POST only", async () => {
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) expect((await raw(server.origin, { method, path: `${base}/`, headers: { host: host() } })).status, method).toBe(405);
    expect((await raw(server.origin, { method: "HEAD", path: `${base}/`, headers: { host: host() } })).status).toBe(200);
  });

  it("slows a loop that guesses tokens, and still serves a good token", async () => {
    let last = 0;
    for (let index = 0; index < 70; index += 1) last = (await get(`/s/${String(index).padStart(43, "x")}/`)).status;
    expect(last).toBe(429);
    expect((await get(`${base}/`)).status).toBe(200);
  });

  it("stops answering a token after it is revoked or expires, and after the server closes", async () => {
    let clock = 1_000;
    const timed = await createLocalPagesServer({ data: world.data, actions: world.actions, now: () => clock });
    const { token: short } = timed.sessions.mint({ ttlMs: 10_000 });
    const timedHost = new URL(timed.origin).host;
    const ask = () => raw(timed.origin, { path: `/s/${short}/`, headers: { host: timedHost } });
    expect((await ask()).status).toBe(200);
    clock += 10_001;
    expect((await ask()).status).toBe(404);
    const second = timed.sessions.mint();
    timed.sessions.revoke(second.token);
    expect((await raw(timed.origin, { path: `/s/${second.token}/`, headers: { host: timedHost } })).status).toBe(404);
    await timed.close();
  });

  it("keeps at most 16 sessions, dropping the oldest", () => {
    const tokens = Array.from({ length: 17 }, () => server.sessions.mint().token);
    expect(server.sessions.find(tokens[0])).toBeUndefined();
    expect(server.sessions.find(tokens[16])).toBeDefined();
  });
});

describe("what a write must carry", () => {
  const planForm = async () => formOf((await get(`${base}/plan/${TASK}`)).body, "/decide");

  it("refuses a POST without an Origin, with another Origin, or with another content type", async () => {
    const { action, fields } = await planForm();
    const body = { ...fields, decision: "approve" };
    expect((await raw(server.origin, { method: "POST", path: action, body: formBody(body), headers: { host: host(), "content-type": "application/x-www-form-urlencoded" } })).status).toBe(403);
    expect((await post(action, body, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(action, body, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(action, body, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(action, body, { "content-type": "application/json" })).status).toBe(415);
    expect(world.actions.calls).toEqual([]);
  });

  it("refuses a body over the limit", async () => {
    const { action, fields } = await planForm();
    const big = await post(action, { ...fields, decision: "approve", note: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(big.status).toBe(413);
    expect(world.actions.calls).toEqual([]);
  });

  it("does nothing without a form token, with a damaged one, or with one drawn for another action, revision, task, session or lesson", async () => {
    const { action, fields } = await planForm();
    const good = { ...fields, decision: "approve" };
    const refused = async (changes: Record<string, string>) => {
      const reply = await post(action, { ...good, ...changes });
      expect(reply.status).toBe(303);
      expect(String(reply.headers.location)).toContain("n=form");
    };
    await refused({ ft: "" });
    await refused({ ft: `${fields.ft}x` });
    await refused({ ft: "1.2" });
    await refused({ revision: "4" });
    await refused({ digest: "sha256-cccc" });
    await refused({ requestId: "card-2" });
    // A token for the comment form is not good for the decision.
    await refused({ ft: formOf((await get(`${base}/plan/${TASK}`)).body, "/comment").fields.ft ?? "" });
    // A token drawn in another session is not good in this one.
    const other = server.sessions.mint().token;
    const otherForm = formOf((await get(`/s/${other}/plan/${TASK}`)).body, "/decide");
    await refused({ ft: otherForm.fields.ft ?? "" });
    expect(world.actions.calls).toEqual([]);
  });

  it("refuses a form token after it expires", async () => {
    let clock = 5_000_000;
    const timed = await createLocalPagesServer({ data: world.data, actions: world.actions, now: () => clock });
    const { token: t } = timed.sessions.mint({ ttlMs: 10 * 3_600_000 });
    const timedHost = new URL(timed.origin).host;
    const page = await raw(timed.origin, { path: `/s/${t}/plan/${TASK}`, headers: { host: timedHost } });
    const { action, fields } = formOf(page.body, "/decide");
    clock += 61 * 60_000;
    const reply = await raw(timed.origin, { method: "POST", path: action, body: formBody({ ...fields, decision: "approve" }), headers: { host: timedHost, origin: timed.origin, "content-type": "application/x-www-form-urlencoded" } });
    expect(String(reply.headers.location)).toContain("n=form");
    expect(world.actions.calls).toEqual([]);
    await timed.close();
  });
});

describe("approving a plan", () => {
  it("sends the approval with a local-session proof for exactly the revision and digest shown, and the approvers seam accepts it once", async () => {
    const approvers = createLocalOwnerApprovers({ verifySession: (token, request) => server.sessions.verifyProof(token, { requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest }) });
    const { action, fields } = formOf((await get(`${base}/plan/${TASK}`)).body, "/decide");
    expect(action).toBe(`${base}/plan/${TASK}/decide`);
    const reply = await post(action, { ...fields, decision: "approve" });
    expect(reply.status).toBe(303);
    expect(String(reply.headers.location)).toBe(`${base}/plan/${TASK}?n=approved`);
    const call = world.actions.calls.at(0)!;
    expect(call.name).toBe("decidePlan");
    const input = call.input as { taskId: string; decision: string; approval: typeof OFFER; proof: { method: string; token: string; requestId: string; revision: number; artifactDigest: string; proofId: string } };
    expect(input).toMatchObject({ taskId: TASK, decision: "approve", approval: OFFER });
    expect(input.proof).toMatchObject({ method: LOCAL_SESSION_METHOD, requestId: OFFER.requestId, revision: OFFER.revision, artifactDigest: OFFER.artifactDigest });
    // The proof is a signed token for this approval only: the page session's own secret is never in it.
    expect(input.proof.token).toMatch(/^p1\./);
    expect(input.proof.token).not.toContain(token);
    const request = { companyId: "org_00000000000000000000", requestId: OFFER.requestId, kind: "plan", subject: { type: "task", id: TASK }, revision: OFFER.revision, artifactDigest: OFFER.artifactDigest };
    expect(await approvers.verify(request, input.proof)).toMatchObject({ approved: true });
    // The same proof cannot decide again, and a proof for another revision is refused.
    expect(await approvers.verify(request, input.proof)).toEqual({ approved: false, reason: "proof_already_used" });
    expect(await approvers.verify({ ...request, revision: 4 }, input.proof)).toEqual({ approved: false, reason: "other_revision" });
  });

  it("does not accept a proof for another request, revision or content, or one forged without the server's key", async () => {
    const { action, fields } = formOf((await get(`${base}/plan/${TASK}`)).body, "/decide");
    await post(action, { ...fields, decision: "approve" });
    const proof = (world.actions.calls[0]!.input as { proof: { token: string } }).proof;
    const binding = { requestId: OFFER.requestId, revision: OFFER.revision, artifactDigest: OFFER.artifactDigest };
    expect(server.sessions.verifyProof(proof.token, binding)).toBe(true);
    for (const other of [{ ...binding, requestId: "card-2" }, { ...binding, revision: 4 }, { ...binding, artifactDigest: "sha256-cccc" }]) expect(server.sessions.verifyProof(proof.token, other)).toBe(false);
    expect(server.sessions.verifyProof(token, binding)).toBe(false);
    expect(server.sessions.verifyProof(`${proof.token.slice(0, -2)}xx`, binding)).toBe(false);
    expect(server.sessions.verifyProof("p1.abc.def", binding)).toBe(false);
    expect(server.sessions.verifyProof("", binding)).toBe(false);
  });

  it("answers a form once: a second click or a replay finds the token used", async () => {
    const { action, fields } = formOf((await get(`${base}/plan/${TASK}`)).body, "/decide");
    expect(String((await post(action, { ...fields, decision: "approve" })).headers.location)).toContain("n=approved");
    expect(String((await post(action, { ...fields, decision: "approve" })).headers.location)).toContain("n=form");
    expect(world.actions.calls).toHaveLength(1);
  });

  it("does not accept a proof once its session is revoked", async () => {
    const approvers = createLocalOwnerApprovers({ verifySession: (token, request) => server.sessions.verifyProof(token, { requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest }) });
    const { action, fields } = formOf((await get(`${base}/plan/${TASK}`)).body, "/decide");
    await post(action, { ...fields, decision: "approve" });
    server.sessions.revoke(token);
    const input = world.actions.calls[0]!.input as { proof: Parameters<typeof approvers.verify>[1] };
    const request = { companyId: "org_00000000000000000000", requestId: OFFER.requestId, kind: "plan", subject: { type: "task", id: TASK }, revision: OFFER.revision, artifactDigest: OFFER.artifactDigest };
    expect((await approvers.verify(request, input.proof)).approved).toBe(false);
  });

  it("asks for changes only with a note, and sends the note", async () => {
    const { action, fields } = await formNow(`/plan/${TASK}`, "/decide");
    expect(String((await post(action, { ...fields, decision: "changes", note: "   " })).headers.location)).toContain("n=invalid");
    expect(world.actions.calls).toEqual([]);
    const again = await formNow(`/plan/${TASK}`, "/decide");
    const reply = await post(again.action, { ...again.fields, decision: "changes", note: "Cap the wait at 30 seconds." });
    expect(String(reply.headers.location)).toContain("n=changes");
    expect(world.actions.calls[0]).toMatchObject({ name: "decidePlan", input: { decision: "changes", note: "Cap the wait at 30 seconds." } });
  });

  it("refuses a decision value it does not know, and a missing request id", async () => {
    const { action, fields } = await formNow(`/plan/${TASK}`, "/decide");
    expect(String((await post(action, { ...fields, decision: "merge" })).headers.location)).toContain("n=invalid");
    expect(String((await post(action, { ...fields, decision: "approve", requestId: "" })).headers.location)).toContain("n=invalid");
    expect(world.actions.calls).toEqual([]);
  });

  it("tells the person when the plan moved on, or the action refused", async () => {
    world.actions.next = { ok: false, reason: "stale", message: "moved" };
    const first = await formNow(`/plan/${TASK}`, "/decide");
    expect(String((await post(first.action, { ...first.fields, decision: "approve" })).headers.location)).toContain("n=stale");
    world.actions.next = { ok: false, reason: "refused", message: "not you" };
    const second = await formNow(`/plan/${TASK}`, "/decide");
    expect(String((await post(second.action, { ...second.fields, decision: "approve" })).headers.location)).toContain("n=refused");
    const page = await get(`${base}/plan/${TASK}?n=stale`);
    expect(page.body).toContain("It changed while you were looking");
    expect((await get(`${base}/plan/${TASK}?n=<script>alert(1)</script>`)).body).not.toContain("<script>");
  });

  it("shows no decision form when nothing waits", async () => {
    world.data.plan = { ...world.data.plan!, approval: undefined as never };
    delete (world.data.plan as { approval?: unknown }).approval;
    expect((await get(`${base}/plan/${TASK}`)).body).not.toContain("Approve this plan");
  });
});

describe("comments", () => {
  it("adds a comment on a claim or the whole plan, and refuses an odd target", async () => {
    const { action, fields } = await formNow(`/plan/${TASK}`, "/comment");
    expect(String((await post(action, { ...fields, target: "1.1", text: "Why not two tries?" })).headers.location)).toContain("n=commented");
    expect(world.actions.calls[0]).toMatchObject({ name: "addComment", input: { taskId: TASK, target: "1.1", text: "Why not two tries?", revision: 3 } });
    const second = await formNow(`/plan/${TASK}`, "/comment");
    expect(String((await post(second.action, { ...second.fields, target: "", text: "Overall: good." })).headers.location)).toContain("n=commented");
    expect(String((await post(second.action, { ...second.fields, target: "../../x", text: "hi" })).headers.location)).toContain("n=form");
    const third = await formNow(`/plan/${TASK}`, "/comment");
    expect(String((await post(third.action, { ...third.fields, target: "../../x", text: "hi" })).headers.location)).toContain("n=invalid");
    const fourth = await formNow(`/plan/${TASK}`, "/comment");
    expect(String((await post(fourth.action, { ...fourth.fields, target: "1", text: "  " })).headers.location)).toContain("n=invalid");
    expect(world.actions.calls).toHaveLength(2);
  });
});

describe("design review", () => {
  it("serves an allowed image with sandboxing headers, and never an svg, an unlisted file or another task's", async () => {
    const png = await get(`${base}/design/${TASK}/mockup/m1`);
    expect(png.status).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(Buffer.compare(png.bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(0);
    expect((await get(`${base}/design/${TASK}/mockup/m2`)).status).toBe(404);
    expect((await get(`${base}/design/${TASK}/mockup/secret`)).status).toBe(404);
    expect((await get(`${base}/design/${OTHER_TASK}/mockup/m1`)).status).toBe(404);
    expect(world.data.mockupReads).not.toContain("0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e11/secret");
  });

  it("approves or rejects with the proof, and a rejection needs a reason", async () => {
    const first = await formNow(`/design/${TASK}`, "/decide");
    expect(String((await post(first.action, { ...first.fields, decision: "reject" })).headers.location)).toContain("n=invalid");
    const second = await formNow(`/design/${TASK}`, "/decide");
    expect(String((await post(second.action, { ...second.fields, decision: "reject", note: "Too cramped." })).headers.location)).toContain("n=rejected");
    const third = await formNow(`/design/${TASK}`, "/decide");
    expect(String((await post(third.action, { ...third.fields, decision: "approve" })).headers.location)).toContain("n=approved");
    expect(world.actions.calls.map((call) => call.name)).toEqual(["decideDesign", "decideDesign"]);
    expect(world.actions.calls[1]!.input).toMatchObject({ approval: DESIGN_OFFER, proof: { method: LOCAL_SESSION_METHOD, requestId: DESIGN_OFFER.requestId, token: expect.stringMatching(/^p1\./) as string } });
  });

  it("a design form does not work on the plan route", async () => {
    const design = formOf((await get(`${base}/design/${TASK}`)).body, "/decide");
    const reply = await post(`${base}/plan/${TASK}/decide`, { ...design.fields, decision: "approve" });
    expect(String(reply.headers.location)).toContain("n=form");
    expect(world.actions.calls).toEqual([]);
  });
});

describe("lessons", () => {
  it("lists them and acts on one with a token for that lesson and that action only", async () => {
    const page = (await get(`${base}/lessons`)).body;
    expect(page).toContain("Run the formatter before committing.");
    const { action, fields } = formOf(page, "/lessons/act");
    expect(fields).toMatchObject({ lessonId: "L1", action: "approve" });
    expect(String((await post(action, fields)).headers.location)).toContain("n=lesson");
    expect(world.actions.calls[0]).toMatchObject({ name: "lessonAction", input: { lessonId: "L1", action: "approve" } });
    // The approve token cannot retire it, nor approve another lesson.
    expect(String((await post(action, { ...fields, action: "retire" })).headers.location)).toContain("n=form");
    expect(String((await post(action, { ...fields, lessonId: "L2" })).headers.location)).toContain("n=form");
    expect(world.actions.calls).toHaveLength(1);
  });

  it("shows the repository lessons file switches, and a switch needs its own form token", async () => {
    const page = (await get(`${base}/lessons`)).body;
    expect(page).toContain("Lessons in the repository");
    const { action, fields } = formOf(page, "/lessons/repo");
    expect(fields).toMatchObject({ project: "payments", repo: "api", action: "on" });
    expect(String((await post(action, { ...fields, action: "off" })).headers.location)).toContain("n=form");
    expect(String((await post(action, { ...fields, repo: "other" })).headers.location)).toContain("n=form");
    expect(world.actions.calls).toEqual([]);
    expect(String((await post(action, fields)).headers.location)).toContain("n=lessonrepo");
    expect(world.actions.calls[0]).toMatchObject({ name: "lessonRepoAction", input: { project: "payments", repo: "api", action: "on", fresh: true } });
  });

  it("switching a repository's lessons file on needs a page opened in the last few minutes; switching off does not", async () => {
    let clock = Date.parse("2026-11-10T10:00:00.000Z");
    const aged = await createLocalPagesServer({ data: world.data, actions: world.actions, now: () => clock });
    try {
      const agedBase = `/s/${aged.sessions.mint().token}`;
      const aHost = new URL(aged.origin).host;
      const getAged = (path: string) => raw(aged.origin, { path, headers: { host: aHost } });
      const postAged = (path: string, fields: Record<string, string>) => raw(aged.origin, { method: "POST", path, body: formBody(fields), headers: { host: aHost, origin: aged.origin, "content-type": "application/x-www-form-urlencoded" } });
      const on = formOf((await getAged(`${agedBase}/lessons`)).body, "/lessons/repo");
      clock += 11 * 60 * 1000;
      expect(String((await postAged(on.action, on.fields)).headers.location)).toContain("n=lessonfresh");
      expect(world.actions.calls).toEqual([]);
      world.data.lessonRepos = [{ project: "payments", canEnable: true, repos: [{ repo: "api", enabled: true, fileDeleted: false, pointer: "not_yet", notices: [] }], available: [] }];
      const off = formOf((await getAged(`${agedBase}/lessons`)).body, "/lessons/repo");
      expect(off.fields["action"]).toBe("off");
      expect(String((await postAged(off.action, off.fields)).headers.location)).toContain("n=lessonrepo");
      expect(world.actions.calls[0]).toMatchObject({ name: "lessonRepoAction", input: { action: "off", fresh: false } });
    } finally { await aged.close(); }
  });

  describe("lessons that went missing from a file", () => {
    const DIGEST = "0123456789abcdef";
    const missingRow = (over: Record<string, unknown> = {}) => ({ repo: "api", enabled: true, fileDeleted: false, pointer: "added" as const, notices: [], retireConfirm: { missing: 7, digest: DIGEST }, ...over });
    /** Every form on the page that posts to /lessons/repo, with its hidden fields. */
    const repoForms = (page: string) => [...page.matchAll(/<form[^>]*action="([^"]+\/lessons\/repo)"[^>]*>([\s\S]*?)<\/form>/g)].map((match) => {
      const fields: Record<string, string> = {};
      for (const input of (match[2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[input[1] ?? ""] = input[2] ?? "";
      return { action: match[1] ?? "", fields };
    });

    it("shows how many are missing with Retire and Keep, each carrying the digest of the set the owner saw", async () => {
      world.data.lessonRepos = [{ project: "payments", canEnable: true, repos: [missingRow()], available: [] }];
      const page = (await get(`${base}/lessons`)).body;
      expect(page).toContain("7 lessons are missing from this file. Retire them, or keep them?");
      const forms = repoForms(page);
      expect(forms.map((form) => form.fields["action"])).toEqual(["retire_confirm", "retire_keep", "off"]);
      expect(forms[0]!.fields["held"]).toBe(DIGEST);
      expect(forms[1]!.fields["held"]).toBe(DIGEST);
      expect(forms[2]!.fields["held"]).toBeUndefined();
      // No card while nothing waits for an answer.
      world.data.lessonRepos = [{ project: "payments", canEnable: true, repos: [missingRow({ retireConfirm: undefined })], available: [] }];
      expect((await get(`${base}/lessons`)).body).not.toContain("missing from this file");
    });

    it("keep and retire reach the action with the digest; the form token binds that digest and the action", async () => {
      world.data.lessonRepos = [{ project: "payments", canEnable: true, repos: [missingRow()], available: [] }];
      const [retire, keep] = repoForms((await get(`${base}/lessons`)).body);
      expect(String((await post(keep!.action, keep!.fields)).headers.location)).toContain("n=lessonretire");
      expect(world.actions.calls[0]).toMatchObject({ name: "lessonRepoAction", input: { project: "payments", repo: "api", action: "retire_keep", held: DIGEST } });
      expect(String((await post(retire!.action, retire!.fields)).headers.location)).toContain("n=lessonretire");
      expect(world.actions.calls[1]).toMatchObject({ input: { action: "retire_confirm", held: DIGEST, fresh: true } });
      const calls = world.actions.calls.length;
      // The keep token cannot retire, and a digest of another set is not the one the token was made for.
      expect(String((await post(keep!.action, { ...keep!.fields, action: "retire_confirm" })).headers.location)).toContain("n=form");
      expect(String((await post(keep!.action, { ...keep!.fields, held: "f".repeat(16) })).headers.location)).toContain("n=form");
      expect(world.actions.calls).toHaveLength(calls);
    });

    it("refuses a missing or malformed digest on these two answers, and a digest on any other action", async () => {
      world.data.lessonRepos = [{ project: "payments", canEnable: true, repos: [missingRow()], available: [] }];
      const [retire, , off] = repoForms((await get(`${base}/lessons`)).body);
      for (const held of [undefined, "nope", "0123456789ABCDEF", `${DIGEST}0`]) {
        const { held: _drop, ...rest } = retire!.fields;
        void _drop;
        expect(String((await post(retire!.action, held === undefined ? rest : { ...rest, held })).headers.location), String(held)).toContain("n=invalid");
      }
      expect(String((await post(off!.action, { ...off!.fields, held: DIGEST })).headers.location)).toContain("n=invalid");
      expect(world.actions.calls).toEqual([]);
    });

    it("retiring needs a page opened in the last few minutes; keeping does not", async () => {
      world.data.lessonRepos = [{ project: "payments", canEnable: true, repos: [missingRow()], available: [] }];
      let clock = Date.parse("2026-11-10T10:00:00.000Z");
      const aged = await createLocalPagesServer({ data: world.data, actions: world.actions, now: () => clock });
      try {
        const agedBase = `/s/${aged.sessions.mint().token}`;
        const aHost = new URL(aged.origin).host;
        const page = (await raw(aged.origin, { path: `${agedBase}/lessons`, headers: { host: aHost } })).body;
        const postAged = (path: string, fields: Record<string, string>) => raw(aged.origin, { method: "POST", path, body: formBody(fields), headers: { host: aHost, origin: aged.origin, "content-type": "application/x-www-form-urlencoded" } });
        const [retire, keep] = repoForms(page);
        clock += 11 * 60 * 1000;
        expect(String((await postAged(retire!.action, retire!.fields)).headers.location)).toContain("n=lessonfresh");
        expect(world.actions.calls).toEqual([]);
        expect(String((await postAged(keep!.action, keep!.fields)).headers.location)).toContain("n=lessonretire");
        expect(world.actions.calls[0]).toMatchObject({ input: { action: "retire_keep", fresh: false } });
      } finally { await aged.close(); }
    });
  });

  it("binds a lesson's approval to its own text and version, and hands the action a proof signed for exactly that", async () => {
    const offer = { requestId: "lesson:L1:3", revision: 3, artifactDigest: "d".repeat(64), risk: "medium" as const };
    world.data.lessons = world.data.lessons.map((lesson) => (lesson.id === "L1" ? { ...lesson, offer } : lesson));
    const { action, fields } = await formNow("/lessons", "/lessons/act");
    expect((await post(action, fields)).headers.location).toContain("n=lesson");
    expect(world.actions.calls[0]).toMatchObject({ name: "lessonAction", input: { lessonId: "L1", action: "approve", offer, proof: { method: LOCAL_SESSION_METHOD, requestId: offer.requestId, revision: 3, artifactDigest: offer.artifactDigest, token: expect.stringMatching(/^p1\./) as string } } });
    // A form drawn for another version of the lesson does not carry over: the lesson changed, so the form is refused and nothing is decided.
    const stale = await formNow("/lessons", "/lessons/act");
    world.data.lessons = world.data.lessons.map((lesson) => (lesson.id === "L1" ? { ...lesson, offer: { ...offer, revision: 4, requestId: "lesson:L1:4" } } : lesson));
    expect(String((await post(stale.action, stale.fields)).headers.location)).toContain("n=form");
    expect(world.actions.calls).toHaveLength(1);
  });

  it("refuses a lesson form after the lesson changed state, so an old form cannot bring a retired lesson back", async () => {
    const { action, fields } = formOf((await get(`${base}/lessons`)).body, "/lessons/act");
    world.data.lessons = world.data.lessons.map((lesson) => (lesson.id === "L1" ? { ...lesson, status: "retired" as const } : lesson));
    expect(String((await post(action, fields)).headers.location)).toContain("n=form");
    expect(String((await post(action, { ...fields, lessonId: "L404" })).headers.location)).toContain("n=missing");
    expect(world.actions.calls).toEqual([]);
  });
});

describe("what the pages show", () => {
  it("shows the waiting list, the plan, the design review and the proof report, each with a policy that forbids script", async () => {
    for (const path of ["/", `/plan/${TASK}`, `/design/${TASK}`, "/lessons", `/proof/${TASK}`]) {
      const reply = await get(`${base}${path}`);
      expect(reply.status, path).toBe(200);
      const policy = String(reply.headers["content-security-policy"]);
      expect(policy).toContain("default-src 'none'");
      expect(policy).not.toMatch(/script-src/);
      expect(policy).toContain("form-action 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(reply.body).not.toMatch(/<script/i);
      expect(reply.body).not.toMatch(/\son[a-z]+=/i);
      expect(reply.body).toContain(`href="${base}/`);
    }
    expect((await get(`${base}/plan/${TASK}`)).body).toContain("Retry failed payments");
    expect((await get(`${base}/proof/${TASK}`)).body).toContain("idempotency.test.ts");
    expect((await get(`${base}/design/${TASK}`)).body).toContain(`${base}/design/${TASK}/mockup/m1`);
  });

  it("escapes every text a model, a reviewer or a repository wrote", async () => {
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    world.data.plan = { ...world.data.plan!, title: evil, status: evil, findings: [{ role: "code", text: evil, file: evil }], comments: [{ id: "c9", author: evil, at: evil, target: "", text: evil }], checks: [{ label: evil, status: "failed" }],
      versions: [{ version: 1, kind: "requirements", approved: false, current: true, content: { format: "markdown", markdown: evil } }] };
    world.data.lessons = [{ id: "L9", text: evil, scope: evil, status: "active", usedIn: [{ taskId: TASK, title: evil }] }];
    world.data.proof = { ...world.data.proof!, title: evil, summary: evil, rows: [{ claim: evil, check: evil, status: "passed", detail: evil }] };
    world.data.design = { ...world.data.design!, title: evil, summary: evil, findings: [{ id: "f", severity: "note", reviewer: evil, text: evil, evidence: [{ label: evil }] }] };
    for (const path of ["/", `/plan/${TASK}`, `/design/${TASK}`, "/lessons", `/proof/${TASK}`]) {
      const body = (await get(`${base}${path}`)).body;
      expect(body, path).not.toContain("<img src=x");
      expect(body, path).not.toContain("<script>");
      expect(body, path).not.toContain("onerror=alert(1)>");
    }
  });

  it("links a pull request only when it is plain https, and shows anything else as text", async () => {
    world.data.plan = { ...world.data.plan!, pullRequests: [{ url: "javascript:alert(1)", number: 1, state: "open" }, { url: "https://user:pw@github.com/x/y/pull/2", number: 2, state: "open" }, { url: "https://github.com/x/y/pull/3", number: 3, state: "open" }] };
    const body = (await get(`${base}/plan/${TASK}`)).body;
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("user:pw");
    expect(body).toContain("href=\"https://github.com/x/y/pull/3\"");
  });

  it("answers 404 for a task it does not know, and for an id that is not a task id", async () => {
    expect((await get(`${base}/plan/${OTHER_TASK}`)).status).toBe(404);
    expect((await get(`${base}/plan/not-a-task`)).status).toBe(404);
    expect((await get(`${base}/design/${OTHER_TASK}`)).status).toBe(404);
    expect((await get(`${base}/proof/${OTHER_TASK}`)).status).toBe(404);
  });

  it("builds links in one owner session, so a second link does not push the first out, and a fresh one on request", async () => {
    const first = new URL(server.link(`/plan/${TASK}`));
    expect(first.origin).toBe(server.origin);
    expect((await get(first.pathname)).status).toBe(200);
    for (let index = 0; index < 20; index += 1) server.link("/lessons");
    expect((await get(first.pathname)).status).toBe(200);
    expect(new URL(server.link("/", { fresh: true })).pathname).not.toBe(new URL(server.link("/")).pathname);
    expect(server.linkIn(token, "lessons")).toBe(`${server.origin}/s/${token}/lessons`);
  });

  it("does not read a notice code from the object prototype", async () => {
    expect((await get(`${base}/?n=constructor`)).body).not.toContain("class=\"notice\"");
  });
});
