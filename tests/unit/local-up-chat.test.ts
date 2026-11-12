// Chat on `rovara up`: a chat adapter in the registry (a fake: no chat tool is named) is started by the app, and the owner's own acts (bind a space, link an account, choose where notices go) are made on the local chat page
// only, never with the API token an AI tool may hold. A message from a linked account in a bound space starts work as the owner, and the conversation is remembered.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, type ActorRef, type ConversationRef, type InboundMessage, type OrgId } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { readTaskThread, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/index.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { readNotifyPrefs } from "../../packages/broker/src/core/notify/index.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { formBody, formOf, raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const PROJECT = {
  name: "web", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const ACTOR: ActorRef = { channel: "examplechat", tenant: "team1", userId: "user1" };
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };

async function launch(withChat = true, clock?: { ms: number }) {
  const root = await mkdtemp(join(tmpdir(), "rovara-chat-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const adapter = new FakeChannelAdapter();
  const opened: string[] = [];
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9",
    machines: new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }), timers: false, storage: "memory", ...(clock === undefined ? {} : { now: () => new Date(clock.ms) }),
    registerAdapters: (registry) => { if (withChat) registry.register("channel", "examplechat", adapter); }, openBrowser: async (url) => { opened.push(url); },
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text || "{}") as Record<string, unknown> };
  };
  const browse = async (path: string, fresh = false): Promise<{ base: string; host: string }> => {
    expect((await api("/v1/local/pages/open", { method: "POST", body: { path, ...(fresh ? { fresh: true } : {}) } })).status).toBe(200);
    const once = new URL(opened.at(-1)!);
    const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    const location = new URL(hop.headers["location"] as string, runtime.pagesUrl);
    return { base: location.pathname.split("/").slice(0, 3).join("/"), host: location.host };
  };
  const page = (where: { base: string; host: string }, path: string) => raw(runtime.pagesUrl, { path: `${where.base}${path}`, headers: { host: where.host } });
  const post = (where: { base: string; host: string }, path: string, fields: Record<string, string>) => raw(runtime.pagesUrl, {
    method: "POST", path: `${where.base}${path}`, body: formBody(fields), headers: { host: where.host, origin: runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" },
  });
  /** Submits the form on /chat whose action ends with `suffix`, with the visible fields the person typed. */
  const submit = async (where: { base: string; host: string }, suffix: string, typed: Record<string, string> = {}) => {
    const drawn = await page(where, "/chat");
    expect(drawn.status).toBe(200);
    const form = formOf(drawn.body, suffix);
    return post(where, `/chat/${suffix.replace(/^\/chat\//u, "")}`, { ...form.fields, ...typed });
  };
  const store = runtime.registry.require("storage");
  return { runtime, adapter, api, browse, page, post, submit, store };
}

const hear = (adapter: FakeChannelAdapter, id: string, text = "add a retry"): Promise<void> => adapter.sink!.message({
  version: 2, channel: "examplechat", eventId: id, conversation: CONVERSATION, actor: ACTOR, text, receivedAt: new Date().toISOString(),
} satisfies InboundMessage);

describe("chat on rovara up", () => {
  it("has no chat page when no chat adapter is set up", async () => {
    const h = await launch(false);
    const where = await h.browse("/chat", true);
    expect((await h.page(where, "/chat")).status).toBe(404);
    expect((await h.api("/v1/app/channel")).body).toMatchObject({ adapters: [], links: [], bindings: [] });
  });

  it("starts the adapter the registry holds, and stops it with the install", async () => {
    const h = await launch();
    expect(h.adapter.sink).toBeDefined();
    await h.runtime.stop();
    expect(h.adapter.stopped).toBe(true);
    cleanup.length = 0;
  });

  it("binds a space, links an account with a code the person pastes, then starts work from a message in the space and remembers the conversation", async () => {
    const h = await launch();
    expect((await h.api("/v1/admin/projects", { method: "POST", body: PROJECT })).status).toBe(201);
    const where = await h.browse("/chat", true);
    // Nothing runs from a space that is not bound.
    await hear(h.adapter, "m0");
    expect(h.adapter.delivered).toEqual([]);
    const bound = await h.submit(where, "/chat/bind", { channel: "examplechat", tenant: "team1", space: "room1", project: "web" });
    expect(bound.headers["location"]).toContain("n=bound");
    // An unlinked person is told how to link; no task starts.
    await hear(h.adapter, "m1");
    const notice = h.adapter.delivered.find((event) => event.type === "progress") as { data: { text: string } };
    const code = /paste this code: ([A-Za-z0-9_-]{32})\./u.exec(notice.data.text)![1]!;
    expect(((await h.api("/v1/dev/tasks")).body["tasks"] as unknown[])).toHaveLength(0);
    // The page shows what the code names and changes nothing until the owner confirms.
    const preview = await h.page(where, `/chat?code=${code}`);
    expect(preview.body).toContain("Link this account?");
    // The owner is shown the workspace and the whole account, not a masked id.
    expect(preview.body).toContain("<code>team1</code>");
    expect(preview.body).toContain("<code>user1</code>");
    expect((await h.page(where, "/chat")).body).toContain("No chat account is linked to you.");
    const form = formOf(preview.body, "/chat/link");
    expect((await h.post(where, "/chat/link", { ...form.fields, confirmed: "no" })).headers["location"]).toContain("n=invalid");
    // Each form answers once: draw it again.
    const again = formOf((await h.page(where, `/chat?code=${code}`)).body, "/chat/link");
    const linked = await h.post(where, "/chat/link", again.fields);
    expect(linked.headers["location"]).toContain("n=linked");
    // The code was one use.
    expect((await h.page(where, `/chat?code=${code}`)).body).toContain("That code is not valid");
    await hear(h.adapter, "m2", "add a retry to the payment call");
    expect(h.adapter.delivered.some((event) => event.type === "ack")).toBe(true);
    const tasks = (await h.api("/v1/dev/tasks")).body["tasks"] as Array<{ taskId: string; client: string; project: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ project: "web" });
    expect(await readTaskThread(h.store, ORG, taskSessionId(tasks[0]!.taskId))).toEqual({ conversation: CONVERSATION, personId: developerIdOf(localOwnerPrincipal()) });
    // The notice went to that account alone.
    expect((notice as unknown as { data: { onlyTo?: string } }).data.onlyTo).toBe("user1");
    // The same chat event again starts nothing.
    await hear(h.adapter, "m2", "add a retry to the payment call");
    expect(((await h.api("/v1/dev/tasks")).body["tasks"] as unknown[])).toHaveLength(1);
  });

  it("starts nothing for an account linked to anyone but the owner", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const where = await h.browse("/chat", true);
    await h.submit(where, "/chat/bind", { channel: "examplechat", tenant: "team1", space: "room1", project: "web" });
    await hear(h.adapter, "m1");
    const code = /paste this code: ([A-Za-z0-9_-]{32})\./u.exec((h.adapter.delivered[0] as { data: { text: string } }).data.text)![1]!;
    // A link row for another person (a stale row, or one from another install).
    await redeemChannelLinkCode({ store: h.store, orgId: ORG, now: () => Date.now() }, "c".repeat(64), code);
    await hear(h.adapter, "m2", "do something as the owner");
    expect(((await h.api("/v1/dev/tasks")).body["tasks"] as unknown[])).toHaveLength(0);
  });

  it("gives a fresh page session to /tokens and /chat only", async () => {
    const h = await launch();
    const plain = await h.browse("/");
    const asked = await h.browse("/", true);
    const plan = await h.browse("/plan/anything", true);
    // Asking for a fresh session on any other page gets the owner's own session, so the page does not count as freshly opened.
    expect(asked.base).toBe(plain.base);
    expect(plan.base).toBe(plain.base);
    const chat = await h.browse("/chat", true);
    expect(chat.base).not.toBe(plain.base);
    const tokens = await h.browse("/tokens", true);
    expect(tokens.base).not.toBe(plain.base);
  });

  it("makes every one of the owner's acts on the page only: the API token cannot link, bind or choose where notices go", async () => {
    const h = await launch();
    for (const path of ["/v1/app/channel", "/v1/app/channel/links", "/v1/app/channel/bindings", "/v1/app/me/notifications"]) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const answer = await h.api(path, { method, body: { code: "x".repeat(32), channel: "examplechat", tenant: "team1", space: "room1", project: "web", targets: [] } });
        expect([401, 404, 405], `${method} ${path}`).toContain(answer.status);
      }
    }
    expect((await readNotifyPrefs(h.store, ORG, developerIdOf(localOwnerPrincipal()))).targets).toEqual([]);
    expect(await h.store.query({ pk: `ORG#${ORG}#CHANNEL_TENANTS` })).toMatchObject({ items: [] });
  });

  it("refuses a form that is forged, replayed or for another subject, and a space of a project the chat does not serve", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: { ...PROJECT, name: "other" } });
    const where = await h.browse("/chat", true);
    const drawn = await h.page(where, "/chat");
    const form = formOf(drawn.body, "/chat/bind");
    const fields = { ...form.fields, channel: "examplechat", tenant: "team1", space: "room1", project: "other" };
    // The chat serves only `web`.
    expect((await h.post(where, "/chat/bind", fields)).headers["location"]).toContain("n=refused");
    // The form answered once: a replay of it finds its token used.
    expect((await h.post(where, "/chat/bind", fields)).headers["location"]).toContain("n=form");
    // A form made for another subject does not carry.
    const mute = formOf((await h.page(where, "/chat")).body, "/chat/mute");
    expect((await h.post(where, "/chat/bind", { ...mute.fields, channel: "examplechat", tenant: "team1", space: "room1", project: "web" })).headers["location"]).toContain("n=form");
    expect((await h.post(where, "/chat/bind", { ft: "forged", channel: "examplechat", tenant: "team1", space: "room1", project: "web" })).headers["location"]).toContain("n=form");
    expect(await h.store.query({ pk: `ORG#${ORG}#CHANNEL_TENANTS` })).toMatchObject({ items: [] });
  });

  it("changes nothing from a page session opened more than ten minutes ago, and says how to open a fresh one", async () => {
    const clock = { ms: Date.now() };
    const h = await launch(true, clock);
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const where = await h.browse("/chat", true);
    const drawn = await h.page(where, "/chat");
    const form = formOf(drawn.body, "/chat/bind");
    clock.ms += 11 * 60_000;
    const refused = await h.post(where, "/chat/bind", { ...form.fields, channel: "examplechat", tenant: "team1", space: "room1", project: "web" });
    expect(refused.headers["location"]).toContain("n=chatfresh");
    expect(await h.store.query({ pk: `ORG#${ORG}#CHANNEL_TENANTS` })).toMatchObject({ items: [] });
  });

  it("chooses where notices go on the page, shows it to the API token read-only, and mutes", async () => {
    const h = await launch();
    const where = await h.browse("/chat", true);
    const added = await h.submit(where, "/chat/notice-add", { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" });
    expect(added.headers["location"]).toContain("n=noticed");
    const shown = (await h.api("/v1/app/me/notifications")).body as { targets: Array<{ conversation: ConversationRef }>; muted: boolean; channels: unknown[] };
    expect(shown.targets).toEqual([{ channel: "examplechat", conversation: CONVERSATION }]);
    expect(shown.channels).toEqual([{ channel: "examplechat", proactive: true }]);
    expect((await h.submit(where, "/chat/mute", { muted: "yes" })).headers["location"]).toContain("n=muted");
    expect(((await h.api("/v1/app/me/notifications")).body as { muted: boolean }).muted).toBe(true);
    expect((await h.submit(where, "/chat/notice-remove", {})).headers["location"]).toContain("n=unnoticed");
    expect(((await h.api("/v1/app/me/notifications")).body as { targets: unknown[] }).targets).toEqual([]);
    // A chat that is not set up here cannot be named.
    const other = await h.submit(where, "/chat/notice-add", { channel: "otherchat", tenant: "team1", space: "room1", thread: "main" });
    expect(other.headers["location"]).toContain("n=missing");
  });

  it("sets quiet hours, the time zone and a daily digest on the page, shows them to the API token read-only, and refuses half a span", async () => {
    const h = await launch();
    const where = await h.browse("/chat", true);
    const saved = await h.submit(where, "/chat/schedule", { quietStart: "22:00", quietEnd: "07:00", timeZone: "Europe/Berlin", digestAt: "09:00" });
    expect(saved.headers["location"]).toContain("n=scheduled");
    const shown = (await h.api("/v1/app/me/notifications")).body;
    expect(shown).toMatchObject({ quietHours: { start: "22:00", end: "07:00" }, timeZone: "Europe/Berlin", digestAt: "09:00", channel: null, emailAvailable: false });
    // The page shows what is set.
    expect((await h.page(where, "/chat")).body).toContain("value=\"22:00\"");
    expect((await h.submit(where, "/chat/schedule", { quietStart: "22:00", quietEnd: "", timeZone: "", digestAt: "" })).headers["location"]).toContain("n=invalid");
    expect((await h.submit(where, "/chat/schedule", { quietStart: "22:00", quietEnd: "07:00", timeZone: "Mars/Olympus", digestAt: "" })).headers["location"]).toContain("n=invalid");
    // Empty fields switch it off; an empty time zone keeps this computer's by name.
    expect((await h.submit(where, "/chat/schedule", { quietStart: "", quietEnd: "", timeZone: "", digestAt: "" })).headers["location"]).toContain("n=scheduled");
    const cleared = await readNotifyPrefs(h.store, ORG, developerIdOf(localOwnerPrincipal()));
    expect(cleared.quietHours).toBeUndefined();
    expect(cleared.digestAt).toBeUndefined();
    expect(cleared.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // The API token cannot change it.
    expect((await h.api("/v1/app/me/notifications", { method: "PUT", body: { digestAt: "08:00" } })).status).not.toBe(200);
  });

  it("shows the read of what is set up with no code and no full account id", async () => {
    const h = await launch();
    const where = await h.browse("/chat", true);
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    await h.submit(where, "/chat/bind", { channel: "examplechat", tenant: "team1", space: "room1", project: "web" });
    await hear(h.adapter, "m1");
    const code = /paste this code: ([A-Za-z0-9_-]{32})\./u.exec((h.adapter.delivered[0] as { data: { text: string } }).data.text)![1]!;
    const form = formOf((await h.page(where, `/chat?code=${code}`)).body, "/chat/link");
    await h.post(where, "/chat/link", form.fields);
    const shown = await h.api("/v1/app/channel");
    expect(shown.text).not.toContain(code);
    expect(shown.text).not.toContain("user1");
    expect(shown.body).toMatchObject({ adapters: [{ name: "examplechat", projects: ["web"] }], bindings: [{ space: "room1", project: "web" }] });
  });
});
