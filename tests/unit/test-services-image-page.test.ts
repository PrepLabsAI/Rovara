// Approving a test service image on the test environment page: a page session opened in the last ten minutes and a form that answers once, bound to the project and the exact image. The page shows the exact reference and
// its registry. Nothing else can approve: not a stale page, not a replayed form, not another image's form, not a form with no token.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalPagesServer, SCRIPT_TOKEN_FRESH_MS, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import type { LocalActionResult, ServiceImagesPageView } from "../../packages/broker/src/core/local-pages/views.js";
import { fakeWorld, formBody, formOf, raw, type FakeWorld } from "../support/local-pages-fakes.js";

const STARTER = "docker.io/library/postgres@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657";
const APPROVED = `docker.io/library/mysql@sha256:${"c".repeat(64)}`;
const images = (): ServiceImagesPageView => ({
  starter: [{ label: "postgres:16 from Docker Hub", reference: STARTER, inEffect: true }],
  owned: [{ label: "mysql:9 from Docker Hub", reference: APPROVED, origin: "page", approvedAt: "2026-11-11T10:00:00.000Z", inEffect: false, stale: false }],
  envList: ["redis:6"],
  proposed: [
    { requested: "postgres:15", label: "postgres:15 from Docker Hub", where: ["docker-compose.yml:4"], status: "needs_approval" },
    { requested: "redis:7", label: "redis:7 from Docker Hub", where: ["docker-compose.yml:9"], status: "builtin" },
  ],
});

let clock = 1_800_000_000_000;
let server: LocalPagesServer;
let world: FakeWorld;
let token: string;
let base: string;
const calls: Array<{ name: string; input: unknown }> = [];
let next: LocalActionResult = { ok: true };

beforeEach(async () => {
  clock = 1_800_000_000_000;
  calls.length = 0;
  next = { ok: true };
  world = fakeWorld();
  server = await createLocalPagesServer({
    now: () => clock,
    data: { ...world.data, async getTestEnvironmentPage(project) { return project === "payments" ? { project, serviceImages: images() } : undefined; } },
    actions: {
      ...world.actions,
      async approveServiceImage(input) { calls.push({ name: "approve", input }); return next; },
      async removeServiceImage(input) { calls.push({ name: "remove", input }); return next; },
    },
  });
  token = server.sessions.mint().token;
  base = `/s/${token}`;
});
afterEach(async () => { await server.close(); });

const host = () => new URL(server.origin).host;
const get = (path: string) => raw(server.origin, { path, headers: { host: host() } });
const post = (path: string, fields: Record<string, string>) => raw(server.origin, { method: "POST", path, body: formBody(fields), headers: { host: host(), origin: server.origin, "content-type": "application/x-www-form-urlencoded" } });
const page = async () => (await get(`${base}/test-environment/payments`)).body;
const notice = (reply: { headers: Record<string, string | string[] | undefined> }) => /n=([a-z]+)/u.exec(String(reply.headers["location"]))?.[1];

describe("the service images panel", () => {
  it("shows the exact pinned reference and its registry, what the project asks for, and an Approve button only for what needs approval", async () => {
    const body = await page();
    expect(body).toContain("Service images");
    expect(body).toContain(STARTER);
    expect(body).toContain(APPROVED);
    expect(body).toContain("registry docker.io");
    expect(body).toContain("Approve postgres:15 from Docker Hub");
    expect(body).not.toContain("Approve redis:7");
    expect(body).toContain("built in, no approval needed");
    expect(body).toContain("ROVARA_TEST_SERVICE_IMAGES lists");
    expect(body).toContain("next time you run <code>rovara up</code>");
  });

  it("shows no Approve or Remove button on a page session that is older than ten minutes, and says to open a new page", async () => {
    clock += SCRIPT_TOKEN_FRESH_MS + 1;
    const body = await page();
    expect(body).not.toContain("Approve postgres:15");
    expect(body).not.toContain("images/remove");
    expect(body).toContain("needs your approval");
    expect(body).toContain("rovara test-env open");
  });
});

describe("approving on the page", () => {
  it("approves what the form was drawn for, from a fresh page, and the form answers once", async () => {
    const form = formOf(await page(), "/images/approve");
    expect(form.fields["requested"]).toBe("postgres:15");
    const done = await post(form.action, form.fields);
    expect(done.status).toBe(303);
    expect(notice(done)).toBe("imageapproved");
    expect(calls).toEqual([{ name: "approve", input: { project: "payments", requested: "postgres:15" } }]);
    const replay = await post(form.action, form.fields);
    expect(notice(replay)).toBe("form");
    expect(calls).toHaveLength(1);
  });

  it("refuses a page session older than ten minutes at the post itself, even with a form drawn while it was fresh, and does nothing", async () => {
    const form = formOf(await page(), "/images/approve");
    clock += SCRIPT_TOKEN_FRESH_MS + 1;
    const late = await post(form.action, form.fields);
    expect(notice(late)).toBe("imagefresh");
    expect(calls).toEqual([]);
  });

  it("refuses a form with no token, a forged token, a token drawn for another image, and another action's token", async () => {
    const form = formOf(await page(), "/images/approve");
    const bare = { ...form.fields };
    delete bare["ft"];
    expect(notice(await post(form.action, bare))).toBe("form");
    expect(notice(await post(form.action, { ...form.fields, ft: `${clock + 1000}.AAAA.BBBB` }))).toBe("form");
    // The token binds the image: the form drawn for postgres:15 cannot approve redis:7 or anything else.
    expect(notice(await post(form.action, { ...form.fields, requested: "redis:7" }))).toBe("form");
    expect(notice(await post(form.action, { ...form.fields, requested: "mysql:9" }))).toBe("form");
    // Nor can another action's form (an approval of the environment, a removal) approve an image.
    const remove = formOf(await page(), "/images/remove");
    expect(notice(await post(form.action, { requested: "postgres:15", ft: remove.fields["ft"]! }))).toBe("form");
    // Nor one drawn for another project.
    expect(notice(await post(form.action.replace("/payments/", "/other/"), form.fields))).toBe("form");
    expect(calls).toEqual([]);
  });

  it("answers nothing for a request from another origin or with the wrong content type", async () => {
    const form = formOf(await page(), "/images/approve");
    const cross = await raw(server.origin, { method: "POST", path: form.action, body: formBody(form.fields), headers: { host: host(), origin: "http://127.0.0.1:1", "content-type": "application/x-www-form-urlencoded" } });
    expect(cross.status).toBe(403);
    const json = await raw(server.origin, { method: "POST", path: form.action, body: JSON.stringify(form.fields), headers: { host: host(), origin: server.origin, "content-type": "application/json" } });
    expect(json.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it("says plainly when the action refused (it could not pin the image, or it is built in)", async () => {
    next = { ok: false, reason: "refused", message: "Docker could not pull that image." };
    const form = formOf(await page(), "/images/approve");
    expect(notice(await post(form.action, form.fields))).toBe("imagerefused");
    next = { ok: false, reason: "stale", message: "It changed while you were looking." };
    const again = formOf(await page(), "/images/approve");
    expect(notice(await post(again.action, again.fields))).toBe("stale");
  });

  it("removes an approved image only with its own form, from a fresh page", async () => {
    const form = formOf(await page(), "/images/remove");
    expect(form.fields["reference"]).toBe(APPROVED);
    expect(notice(await post(form.action, form.fields))).toBe("imageremoved");
    expect(calls).toEqual([{ name: "remove", input: { project: "payments", reference: APPROVED } }]);
    const second = formOf(await page(), "/images/remove");
    clock += SCRIPT_TOKEN_FRESH_MS + 1;
    expect(notice(await post(second.action, second.fields))).toBe("imagefresh");
  });

  it("is not found when the install does not manage images (no action given)", async () => {
    const plain = await createLocalPagesServer({ now: () => clock, data: world.data, actions: { ...world.actions } });
    const session = plain.sessions.mint().token;
    const reply = await raw(plain.origin, { method: "POST", path: `/s/${session}/test-environment/payments/images/approve`, body: formBody({ requested: "postgres:15", ft: "x" }), headers: { host: new URL(plain.origin).host, origin: plain.origin, "content-type": "application/x-www-form-urlencoded" } });
    expect(reply.status).toBe(404);
    await plain.close();
  });
});
