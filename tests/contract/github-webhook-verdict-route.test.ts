// Reviewer-added (uncommitted): the REAL broker legacy webhook path decides "not linked" (202 ignored) vs "mismatch" (403) from real rows, not from a stubbed authorizer.
import { createHmac } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

const ID = "550e8400-e29b-41d4-a716-446655440031";
beforeAll(loadSlackBroker);
const URL = "https://github.com/example/demo/pull/1";
const DIGEST = "a".repeat(64);
function seed(db: FakeDynamoDb, o: { link?: boolean; closed?: boolean; project?: boolean | "other-repo"; trackPr?: boolean; core?: boolean; closedAtOnly?: boolean } = {}) {
  if (o.link !== false) db.set({ pk: "GITHUB_PR#example/demo", sk: "PR#0000000001", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo", repositoryId: "demo", number: 1, url: URL, taskId: "task", workspaceId: "w", candidateDigest: DIGEST });
  db.set({ pk: "DEVTASK#task", sk: "META", project: "demo", startingRevision: 1, workflow: { stage: o.closed ? "CLOSED" : "WAIT_FOR_MERGE", pullRequests: o.trackPr === false ? [] : [{ repositoryId: "demo", number: 1, url: URL, candidateDigest: DIGEST }] } });
  if (o.project !== false) db.set({ pk: "PROJECT#demo", sk: "REV#000000000001", definition: { repositories: [{ name: o.project === "other-repo" ? "other" : "demo", url: "https://github.com/example/demo.git" }] } });
}
async function send(seeded: NonNullable<Parameters<typeof seed>[1]>, verify: boolean | (() => Promise<boolean>), signed = true) {
  const db = new FakeDynamoDb();
  const { handler } = createBroker({ extra: { documentClient: db, githubWebhookSecret: async () => "fixture-only", githubPullRequests: { verifyWebhookRepository: typeof verify === "function" ? verify : async () => verify } } });
  seed(db, seeded);
  if (seeded.closedAtOnly) db.set({ ...db.get("DEVTASK#task", "META")!, closedAt: "2026-11-23T00:00:00.000Z" });
  const body = JSON.stringify({ action: "opened", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, pull_request: { number: 1 } });
  const sig = createHmac("sha256", signed ? "fixture-only" : "wrong").update(body).digest("hex");
  const r = await handler({ rawPath: "/v1/github/webhooks", body, headers: { "x-github-delivery": ID, "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${sig}` }, requestContext: { requestId: "t", http: { method: "POST" } } });
  return { r, db, json: JSON.parse(r.body) as Record<string, unknown> };
}
it("no link row: 202 not_linked, nothing written", async () => {
  const { r, json, db } = await send({ link: false }, true);
  expect(r.statusCode).toBe(202); expect(json).toMatchObject({ ignored: true, reason: "not_linked" });
  expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")).toBeUndefined();
});
it("link row but the task is closed, or no longer lists the PR: 202 not_linked", async () => {
  expect((await send({ closed: true }, true)).json).toMatchObject({ reason: "not_linked" });
  expect((await send({ trackPr: false }, true)).json).toMatchObject({ reason: "not_linked" });
});
it("linked task, pinned project lacks the repo, or live GitHub disagrees: stays 403 (never ignored)", async () => {
  for (const [s, v] of [[{ project: "other-repo" }, true], [{}, false]] as const) {
    const { r, json, db } = await send(s, v);
    expect(r.statusCode).toBe(403); expect(JSON.stringify(json)).toMatch(/outside the registered installation and repository scope/);
    expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")).toBeUndefined();
  }
});
it("linked and verified: accepted (real feedback is not dropped)", async () => {
  // Authorized: the delivery is reserved (a row exists); the later processing step needs more fixtures than this test builds, so only the reservation is asserted.
  const { db, json } = await send({}, true);
  expect(json).not.toHaveProperty("ignored");
  expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")).toBeDefined();
});
it("a live-GitHub outage during verification is still retryable, not ignored", async () => {
  const { AgentXError } = await import("@agentx/contracts");
  const { r } = await send({}, async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", "down", 503); });
  expect(r.statusCode).toBe(503);
});
it("bad signature is 403 for every link state", async () => {
  for (const s of [{ link: false }, {}, { closed: true }, { project: "other-repo" }] as const) expect((await send(s, true, false)).r.statusCode).toBe(403);
});
