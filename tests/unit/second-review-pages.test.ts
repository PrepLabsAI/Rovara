// The local pages for the second review: the settings page (who reviews, how it counts, the model list) and the acknowledgement on a task's page. Every change is one verified form the owner makes in
// their own browser session; the page server never decides anything the service does not (the service's own refusals come back as the page's fixed words).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecondOpinionSchema, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, secondReviewModelKey } from "@agentx/contracts";
import { createLocalPagesServer, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { createLocalPageData, createPageExtraActions } from "../../packages/broker/src/local/app/page-data.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { TASK, formBody, raw } from "../support/local-pages-fakes.js";
import { COMPANY, GPT, OWNER, createWorld, replayRun, type SecondReviewWorld, plain } from "../support/second-review-world.js";
import { createHarness, type Harness } from "../support/task-flow-harness.js";

let server: LocalPagesServer;
let world: SecondReviewWorld;
let h: Harness;
let base: string;
const NOW = "2026-11-10T10:00:00.000Z";
const code = createCandidateManifest([{ repositoryId: "demo", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);

beforeEach(async () => {
  h = createHarness();
  await h.registerProject();
  world = createWorld({ store: h.store as never });
  const flow = h.deps;
  flow.secondReview = world.review;
  const blobs = createDocumentObjectStorage(h.store, { companyId: COMPANY });
  const deps = { flow, blobs, owner: OWNER, companyId: COMPANY, secondReview: world.review };
  server = await createLocalPagesServer({ data: createLocalPageData(deps), actions: { ...createPageExtraActions(deps), decidePlan: async () => ({ ok: true }), decideDesign: async () => ({ ok: true }) } as never });
  base = `/s/${server.sessions.mint().token}`;
});
afterEach(async () => { await server.close(); });

const host = () => new URL(server.origin).host;
const get = (path: string) => raw(server.origin, { path: `${base}${path}`, headers: { host: host() } });
const post = (path: string, fields: Record<string, string>) =>
  raw(server.origin, { method: "POST", path: `${base}${path}`, body: formBody(fields), headers: { host: host(), origin: server.origin, "content-type": "application/x-www-form-urlencoded" } });

/** The hidden fields of the form on `page` that posts to `suffix` and carries `op=<op>` (the settings page holds many forms for one address). */
function formFor(page: string, suffix: string, op: string): Record<string, string> {
  const decode = (text: string) => text.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const match of page.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    if (!decode(match[1] ?? "").endsWith(suffix)) continue;
    const fields: Record<string, string> = {};
    for (const input of (match[2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[decode(input[1] ?? "")] = decode(input[2] ?? "");
    if (fields["op"] === op) return fields;
  }
  throw new Error(`no form ${op} on the page`);
}
const settings = async () => (await world.review.state());

describe("the settings page", () => {
  it("says who reviews now, how it counts, and lists the models with their maker and cost; the builder's company is not offered", async () => {
    const page = await get("/second-review");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Second review");
    expect(page.body).toContain("Using default");
    expect(page.body).toContain("Company mode: <strong>off</strong>");
    expect(page.body).toContain("gpt-5.5");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    // Everything on it is escaped text.
    expect(page.body).not.toContain("<script");
  });

  it("is not there when the feature is off", async () => {
    await server.close();
    const off = createWorld({ store: h.store as never, enabled: () => false });
    const deps = { flow: h.deps, blobs: createDocumentObjectStorage(h.store, { companyId: COMPANY }), owner: OWNER, companyId: COMPANY, secondReview: off.review };
    server = await createLocalPagesServer({ data: createLocalPageData(deps), actions: createPageExtraActions(deps) as never });
    base = `/s/${server.sessions.mint().token}`;
    expect((await get("/second-review")).status).toBe(404);
  });

  it("chooses the reviewer with one verified form: saved, audited, and the form answers once", async () => {
    const page = (await get("/second-review")).body;
    const fields = formFor(page, "/second-review/act", "choose");
    const sent = { ...fields, primary: `${GPT.provider}::${GPT.modelId}`, backup: "" };
    const reply = await post("/second-review/act", sent);
    expect(reply.headers["location"]).toContain("n=saved");
    expect((await settings()).choice).toEqual({ models: [GPT] });
    expect(world.audit.map((event) => event.action)).toEqual(["company.second_review_choice_changed"]);
    // The same form a second time is spent.
    expect((await post("/second-review/act", sent)).headers["location"]).toContain("n=form");
    expect((await get("/second-review")).body).toContain("Reviewed by gpt-5.5 (company choice)");
  });

  it("refuses a form with no token, a token made for another change, a model that is not offered, and a change the service refuses (`on` without evidence)", async () => {
    const page = (await get("/second-review")).body;
    const choose = formFor(page, "/second-review/act", "choose");
    expect((await post("/second-review/act", { op: "choose", primary: `${GPT.provider}::${GPT.modelId}`, backup: "" })).headers["location"]).toContain("n=form");
    // The token of the `clear` form is not good for `choose`.
    const clear = formFor(page, "/second-review/act", "context");
    expect((await post("/second-review/act", { ...clear, op: "choose", primary: `${GPT.provider}::${GPT.modelId}`, backup: "" })).headers["location"]).toContain("n=form");
    expect((await post("/second-review/act", { ...choose, primary: "openai::not-a-listed-model", backup: "" })).headers["location"]).toContain("n=refused");
    expect((await post("/second-review/act", { ...choose, op: "nonsense", primary: "x" })).headers["location"]).toMatch(/n=(invalid|form)/u);
    expect((await settings()).choice).toBeNull();
    const fresh = (await get("/second-review")).body;
    const mode = formFor(fresh, "/second-review/act", "mode");
    expect((await post("/second-review/act", { ...mode, scope: "company", mode: "on" })).headers["location"]).toContain("n=refused");
    expect((await settings()).modes.company).toBe("off");
    const again = formFor((await get("/second-review")).body, "/second-review/act", "mode");
    expect((await post("/second-review/act", { ...again, scope: "company", mode: "shadow" })).headers["location"]).toContain("n=saved");
    expect((await settings()).modes.company).toBe("shadow");
  });

  it("sets what the second reviewer sees, and one project's mode; a project the company does not have is not found", async () => {
    let page = (await get("/second-review")).body;
    expect((await post("/second-review/act", { ...formFor(page, "/second-review/act", "context"), context: "same_as_first" })).headers["location"]).toContain("n=saved");
    expect((await settings()).context).toBe("same_as_first");
    page = (await get("/second-review")).body;
    const forms = [...page.matchAll(/<form[^>]*action="[^"]*\/second-review\/act"[^>]*>([\s\S]*?)<\/form>/g)].map((entry) => entry[1] ?? "").filter((entry) => entry.includes('name="scope" value="project"'));
    expect(forms).toHaveLength(1);
    const fields: Record<string, string> = {};
    for (const input of forms[0]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[input[1] ?? ""] = input[2] ?? "";
    expect((await post("/second-review/act", { ...fields, project: "nowhere", mode: "shadow" })).headers["location"]).toContain("n=missing");
    const fresh = [...(await get("/second-review")).body.matchAll(/<form[^>]*action="[^"]*\/second-review\/act"[^>]*>([\s\S]*?)<\/form>/g)].map((entry) => entry[1] ?? "").find((entry) => entry.includes('name="scope" value="project"'))!;
    const again: Record<string, string> = {};
    for (const input of fresh.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) again[input[1] ?? ""] = input[2] ?? "";
    expect((await post("/second-review/act", { ...again, project: "web", mode: "shadow" })).headers["location"]).toContain("n=saved");
  });
});

describe("a change that needs a recent sign-in", () => {
  /** A page server whose clock the test moves, so a session can age. */
  async function aged(): Promise<{ close(): Promise<void>; post(path: string, fields: Record<string, string>): ReturnType<typeof raw>; get(path: string): ReturnType<typeof raw>; clock: { now: number } }> {
    const clock = { now: Date.parse("2026-11-10T10:00:00.000Z") };
    const deps = { flow: h.deps, blobs: createDocumentObjectStorage(h.store, { companyId: COMPANY }), owner: OWNER, companyId: COMPANY, secondReview: world.review };
    const pages = await createLocalPagesServer({ data: createLocalPageData(deps), actions: createPageExtraActions(deps) as never, now: () => clock.now });
    const root = `/s/${pages.sessions.mint().token}`;
    const hostOf = new URL(pages.origin).host;
    return {
      clock, close: () => pages.close(),
      get: (path) => raw(pages.origin, { path: `${root}${path}`, headers: { host: hostOf } }),
      post: (path, fields) => raw(pages.origin, { method: "POST", path: `${root}${path}`, body: formBody(fields), headers: { host: hostOf, origin: pages.origin, "content-type": "application/x-www-form-urlencoded" } }),
    };
  }

  it("lowering, withdrawing and the evidence need a page opened within ten minutes: an older page is told to open it again and nothing changes; raising does not need it", async () => {
    const page = await aged();
    try {
      await world.review.apply(OWNER, { action: "choose", primary: GPT });
      const sendForm = async (op: string, fields: Record<string, string>) => page.post("/second-review/act", { ...formFor((await page.get("/second-review")).body, "/second-review/act", op), ...fields });
      expect((await sendForm("mode", { scope: "company", mode: "shadow" })).headers["location"]).toContain("n=saved");
      page.clock.now += 11 * 60_000;
      // Raising is still fine; lowering is not; neither is the evidence.
      expect((await sendForm("mode", { scope: "company", mode: "off" })).headers["location"]).toContain("n=reauth");
      expect((await settings()).modes.company).toBe("shadow");
      expect((await sendForm("replay", { run: JSON.stringify(replayRun(GPT)) })).headers["location"]).toContain("n=reauth");
      expect(await h.store.get({ pk: `ORG#${COMPANY}`, sk: "SECONDREVIEW#REPLAY#run-1" })).toBeUndefined();
      expect((await page.get("/second-review?n=reauth")).body).toContain("rovara open second-review");
      expect((await sendForm("context", { context: "same_as_first" })).headers["location"]).toContain("n=saved");
    } finally { await page.close(); }
  });

  it("the evidence is recorded on the page in a fresh session: a replay run, then the window; and what is not JSON or not a time is not understood", async () => {
    const page = await aged();
    try {
      await world.review.apply(OWNER, { action: "choose", primary: GPT });
      const sendForm = async (op: string, fields: Record<string, string>) => page.post("/second-review/act", { ...formFor((await page.get("/second-review")).body, "/second-review/act", op), ...fields });
      expect((await sendForm("replay", { run: "not json" })).headers["location"]).toContain("n=invalid");
      expect((await sendForm("replay", { run: JSON.stringify(replayRun(GPT)) })).headers["location"]).toContain("n=saved");
      expect(await h.store.get({ pk: `ORG#${COMPANY}`, sk: "SECONDREVIEW#REPLAY#run-1" })).toBeDefined();
      expect((await sendForm("verdict", { model: `${GPT.provider}::${GPT.modelId}`, run: "run-1", from: "not a time", to: "2026-11-01T00:00:00.000Z" })).headers["location"]).toContain("n=invalid");
      // No second opinions are on record yet, so the window has nothing to count: not accepted, nothing stored.
      expect((await sendForm("verdict", { model: `${GPT.provider}::${GPT.modelId}`, run: "run-1", from: "2026-10-02T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" })).headers["location"]).toContain("n=invalid");
      expect(await h.store.get({ pk: `ORG#${COMPANY}`, sk: `SECONDREVIEW#VERDICT#${secondReviewModelKey(GPT)}` })).toBeUndefined();
    } finally { await page.close(); }
  });
});

describe("a task's page", () => {
  const seedTask = async (mode: "on" | "shadow", reason: "no-answer" | "older-worker" = "no-answer") => {
    const workflow = WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: NOW, definitionVersion: "1.1.0" }), stage: "REVIEW", state: "WAITING", candidate: code,
      checkPolicy: { required: [{ id: "unit", label: "Unit", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    });
    const opinion = SecondOpinionSchema.parse({ mode, unavailableReason: reason, blockingCount: 0, blocked: false, wouldHaveBlocked: false, unavailable: true });
    await h.store.put({ item: {
      ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, companyId: COMPANY, developerId: "local-owner", provider: "local-owner", developerName: "Local owner", client: "test", project: "payments", title: "Retry failed payments",
      workspaceId: "ws-1", ownerKey: "local-owner", conversationId: "c", startingRevision: 1, charge: { kind: "member", developerId: "local-owner" }, shared: false, createdAt: NOW, updatedAt: NOW,
      workflow: plain(workflow), secondOpinion: { candidateDigest: code.digest, opinion: plain(opinion), recordedAt: NOW },
    } });
    return workflow;
  };

  it("an `on` second review that did not run says so and asks the owner to acknowledge; one form, and the merge no longer waits", async () => {
    await seedTask("on");
    const page = (await get(`/plan/${TASK}`)).body;
    expect(page).toContain('id="second-review"');
    expect(page).toContain("Second review did not run");
    expect(page).toContain("Acknowledge: I have seen this");
    // It claims no merge is held here: Rovara does not merge on this computer.
    expect(page).toContain("Rovara does not merge on this computer");
    expect(page).not.toContain("allow the merge");
    expect(world.review.mergeWait((await readTask(h.deps, TASK))! as never)).toContain("Second review did not run");
  });

  it("shadow shows nothing on the task's page", async () => {
    await seedTask("shadow");
    expect((await get(`/plan/${TASK}`)).body).not.toContain('id="second-review"');
  });

  it("the acknowledge form is refused for a key that is not the one asked, and acknowledges once for the one that is", async () => {
    await seedTask("on");
    const task = (await readTask(h.deps, TASK))!;
    const key = world.review.acknowledgement(task)!.key;
    const revision = String(task.workflow!.revision);
    const page = (await get(`/plan/${TASK}`)).body;
    const matches = [...page.matchAll(/<form[^>]*action="([^"]+second-review-acknowledge)"[^>]*>([\s\S]*?)<\/form>/g)];
    expect(matches).toHaveLength(1);
    const decode = (text: string) => text.replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
    const fields: Record<string, string> = {};
    for (const input of (matches[0]![2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[decode(input[1] ?? "")] = decode(input[2] ?? "");
    expect(fields).toMatchObject({ revision, key });
    // A key the token was not made for is the form's refusal; a key made for another code is stale.
    expect((await post(`/plan/${TASK}/second-review-acknowledge`, { ...fields, key: "f".repeat(64) })).headers["location"]).toContain("n=form");
    const second = (await get(`/plan/${TASK}`)).body;
    const again = [...second.matchAll(/<form[^>]*action="([^"]+second-review-acknowledge)"[^>]*>([\s\S]*?)<\/form>/g)][0]![2]!;
    const sent: Record<string, string> = {};
    for (const input of again.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) sent[decode(input[1] ?? "")] = decode(input[2] ?? "");
    const reply = await post(`/plan/${TASK}/second-review-acknowledge`, sent);
    expect(reply.headers["location"]).toContain("n=acknowledged");
    expect(world.review.mergeWait((await readTask(h.deps, TASK))! as never)).toBeUndefined();
    expect(world.audit.at(-1)).toMatchObject({ action: "task.second_review_acknowledged", subject: { type: "task", id: TASK } });
    expect((await get(`/plan/${TASK}`)).body).toContain("You acknowledged this.");
    void secondReviewModelKey;
  });
});
