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
// D1-2: the old workflow's webhook handler (and its linked / not-linked / mismatch verdicts) is deleted. A pull request event that is not a core task's is answered 202 IGNORED
// whatever the old link rows say, and writes nothing; the signature is still checked first.
it("a pull request event with an old link row, or none, or a closed task, or a repo the project lacks, is 202 IGNORED and writes nothing", async () => {
  for (const seeded of [{ link: false }, {}, { closed: true }, { trackPr: false }, { project: "other-repo" }] as const) {
    const { r, json, db } = await send(seeded, true);
    expect(r.statusCode).toBe(202);
    expect(json).toMatchObject({ delivery: "IGNORED" });
    expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")).toBeUndefined();
  }
});
it("is ignored without asking live GitHub, so an outage there changes nothing", async () => {
  const { r } = await send({}, async () => { throw new Error("GitHub must not be asked"); });
  expect(r.statusCode).toBe(202);
});
it("bad signature is 403 for every link state", async () => {
  for (const s of [{ link: false }, {}, { closed: true }, { project: "other-repo" }] as const) expect((await send(s, true, false)).r.statusCode).toBe(403);
});
