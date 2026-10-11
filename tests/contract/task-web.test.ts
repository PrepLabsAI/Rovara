// Task 18 (gap 4): the read-only AgentX task page a brief Slack message links to.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot } from "@agentx/contracts";
import { createTaskWeb, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { MAYA, OMAR, createDeveloperTaskBroker, type Developer } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL } from "../support/slack-broker.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const view: TaskDocumentView = { taskId, title: "Add greet <img src=x>", status: "Waiting for your approval", nextStep: "Approve or request changes in Slack.",
  documents: [{ kind: "coding plan", version: 2, markdown: "# Plan\n<script>alert(1)</script>\n1. Add greet", approved: false }],
  checks: [{ label: "npm test", passed: true }], findings: [{ role: "code", text: "Drops <b>last</b> line", origin: "INTRODUCED", file: "src/a.ts", line: 3 }],
  pullRequests: [], replies: [{ author: "teammate", text: "check <i>mobile</i>", at: "2026-10-07T12:00:00.000Z" }] };
const request = (path: string, cookie?: string): AdaptedHttpRequest => ({ method: "GET", path, headers: cookie === undefined ? {} : { cookie }, requestId: "r" });
const caller = { developerId: "d".repeat(64), sessionId: "s", amr: "slack", name: "Maya" } as const;
const SESSION = "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111";
const pageUrl = new URL(`https://agentx.example.test/review/${taskId}/task`);
const render = (overrides: Partial<TaskDocumentView>) =>
  createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => ({ ...view, ...overrides }) })(request(`/review/${taskId}/task`, SESSION), pageUrl);
/** What a reader sees: the body's text, without tags, styles or attributes. */
const visible = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");

describe("read-only task page", () => {
  it("sends a signed-out reader to sign in and back to the task page", async () => {
    const web = createTaskWeb({ authenticateSession: async () => undefined, getTaskDocumentView: async () => view });
    const answer = await web(request(`/review/${taskId}/task`), new URL(`https://agentx.example.test/review/${taskId}/task`));
    expect(answer.statusCode).toBe(302);
    expect(answer.headers.location).toBe(`/v1/auth/browser/authorize?return_to=${encodeURIComponent(`/review/${taskId}/task`)}`);
  });

  it("shows the full document, findings and replies escaped, with no script and a locked-down policy", async () => {
    const web = createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => view });
    const answer = await web(request(`/review/${taskId}/task`, SESSION), new URL(`https://agentx.example.test/review/${taskId}/task`));
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(answer.body).toContain("Drops &lt;b&gt;last&lt;/b&gt; line");
    expect(answer.body).toContain('id="findings"');
    expect(answer.body).not.toMatch(/<script|<form/);
    expect(answer.headers["content-security-policy"]).toContain("script-src 'none'");
    expect(answer.headers["cache-control"]).toContain("no-store");
  });

  it("hides a task the reader may not see", async () => {
    const web = createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => { throw Object.assign(new Error("x"), { code: "TASK_NOT_FOUND" }); } });
    expect((await web(request(`/review/${taskId}/task`, SESSION), new URL(`https://agentx.example.test/review/${taskId}/task`))).statusCode).toBe(404);
  });

  it("sends a reader whose session ended back to sign in, and answers only GET", async () => {
    const web = createTaskWeb({ authenticateSession: async () => undefined, getTaskDocumentView: async () => view });
    const expired = await web(request(`/review/${taskId}/task`, SESSION), pageUrl);
    expect(expired.statusCode).toBe(302);
    expect(expired.headers.location).toContain(encodeURIComponent(`/review/${taskId}/task`));
    const post = await createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => view })({ ...request(`/review/${taskId}/task`, SESSION), method: "POST" }, pageUrl);
    expect(post.statusCode).toBe(405);
  });

  it("splits findings into this change's and older ones, and shows a file only when it is a plain relative path", async () => {
    const answer = await render({ findings: [
      { role: "security", text: "Token logged", origin: "INTRODUCED", file: "src/log.ts", line: 9 },
      { role: "code", text: "Old retry loop", origin: "PRE_EXISTING", file: "../../etc/passwd" },
      { role: "code", text: "Odd path", origin: "PRE_EXISTING", file: "/abs/path.ts" },
      { role: "code", text: "Link path", origin: "INTRODUCED", file: "https://evil.example/x.ts" },
    ] });
    const findings = answer.body.slice(answer.body.indexOf('id="findings"'));
    expect(findings.indexOf("Caused by this change")).toBeLessThan(findings.indexOf("Token logged"));
    expect(findings.indexOf("Already in the code (advisory)")).toBeGreaterThan(findings.indexOf("Token logged"));
    expect(findings.indexOf("Old retry loop")).toBeGreaterThan(findings.indexOf("Already in the code (advisory)"));
    expect(answer.body).toContain("src/log.ts:9");
    expect(answer.body).not.toContain("etc/passwd");
    expect(answer.body).not.toContain("/abs/path.ts");
    expect(answer.body).not.toContain("evil.example");
  });

  it("links pull requests only on GitHub over https, without passing on who sent the reader", async () => {
    const answer = await render({ pullRequests: [
      { url: "https://github.com/example/demo/pull/42", number: 42, state: "OPEN" },
      { url: "javascript:alert(1)", number: 43, state: "OPEN" },
      { url: "https://evil.example/pull/44", number: 44, state: "MERGED" },
    ] });
    expect(answer.body).toContain('href="https://github.com/example/demo/pull/42" rel="noopener noreferrer nofollow"');
    expect(answer.body).not.toContain("javascript:");
    expect(answer.body).not.toContain("evil.example");
    expect(answer.body).toContain("#44");
  });

  it("renders a model's links in a document as plain text, and says when a document couldn't be verified", async () => {
    const answer = await render({ documents: [{ kind: "design", version: 1, markdown: "See [docs](https://evil.example/x) and <a href=\"https://evil.example\">here</a>", approved: true }], unverified: ["coding plan"] });
    expect(answer.body).not.toMatch(/<a [^>]*evil\.example/);
    expect(answer.body).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(answer.body).toContain("The saved coding plan couldn't be verified, so it isn't shown.");
    expect(answer.body).toContain("Approved");
  });

  it("uses plain words: no internal terms reach the reader", async () => {
    const answer = await render({ unverified: ["requirements"], pullRequests: [{ url: "https://github.com/example/demo/pull/42", number: 42, state: "UNKNOWN" }],
      checks: [{ label: "npm test", passed: true }, { label: "lint", passed: false }, { label: "e2e", passed: undefined }] });
    expect(visible(answer.body)).not.toMatch(/candidate|revision|digest|operation|artifact|workflow|SUCCEEDED|FAILED|invalid json/i);
    expect(visible(answer.body)).toContain("1 thread reply");
  });
});

describe("the task page through the broker", () => {
  const TEAMMATE: Developer = { developerId: "f".repeat(64), name: "Lee Park", provider: "slack", sessionId: "s-lee", slackUserId: "U0LEE0001" };

  async function sharedPlanTask(extra: (saved: { ownerKey: string; workspaceId: string }) => Record<string, unknown> = () => ({})) {
    const slack = { down: false };
    const harness = await createDeveloperTaskBroker({ channelMembers: async (request) => {
      if (slack.down) throw new Error("Slack is down");
      return { ok: true, memberOf: request.slackUserId === MAYA.slackUserId || request.slackUserId === TEAMMATE.slackUserId ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [] };
    } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "test", shareToChannel: true });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const id = (started.body.task as { taskId: string }).taskId;
    const task = harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { ownerKey: string; workspaceId: string };
    const plan = `# Plan\n\nGoal: fix retry handling.\n\n1. Fix it\n${"P".repeat(2_000)}`;
    const objectKey = `private/${task.ownerKey}/${task.workspaceId}/artifacts/plan.md`;
    harness.s3.objects.set(objectKey, plan);
    const now = new Date().toISOString();
    const base = createWorkflowSnapshot({ taskId: id, ownerId: task.ownerKey, now });
    harness.db.set({ ...task, workflow: { ...base, revision: 3, stage: "PLAN_REVIEW", state: "WAITING",
      artifacts: [{ id: "plan-1", type: "plan", version: 1, sha256: createHash("sha256").update(plan).digest("hex"), producer: "test", objectKey, createdAt: now }], ...extra(task) } });
    for (const who of [MAYA, OMAR, TEAMMATE]) {
      harness.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name,
        ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    }
    const open = async (who: Developer) => {
      const sessionId = randomUUID();
      harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: who.developerId, amr: who.provider,
        startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
      return await harness.handler({
        version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${id}/task`, rawQueryString: "",
        headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}` },
        requestContext: { requestId: randomUUID(), http: { method: "GET" } },
      }) as { statusCode: number; headers: Record<string, string>; body: string };
    };
    return { harness, id, plan, objectKey, open, slack };
  }

  const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");

  it("answers a teammate 'not found' when Slack can't confirm their membership, and tells them it's the owner's approval", async () => {
    const { open, slack } = await sharedPlanTask();
    const member = await open(TEAMMATE);
    expect(member.statusCode).toBe(200);
    expect(member.body).toContain("Waiting for the owner&#39;s approval");
    expect(member.body).not.toContain("your approval");
    slack.down = true;
    const unconfirmed = await open(TEAMMATE);
    expect(unconfirmed.statusCode).toBe(404);
    expect(unconfirmed.body).not.toContain("retry");
    // The owner's page needs no Slack lookup.
    expect((await open(MAYA)).statusCode).toBe(200);
  });

  it("reads documents only from the task's own storage, and shows the rest when one can't be read", async () => {
    const elsewhere = "# Design\n\nFrom another task.";
    const { harness, open } = await sharedPlanTask((saved) => {
      const now = new Date().toISOString();
      return { artifacts: [
        { id: "req-1", type: "requirements", version: 1, sha256: digestOf("# Requirements\n\nGone."), producer: "test", objectKey: `private/${saved.ownerKey}/${saved.workspaceId}/artifacts/missing.md`, createdAt: now },
        { id: "design-1", type: "design", version: 1, sha256: digestOf(elsewhere), producer: "test", objectKey: `private/${"0".repeat(64)}/other-workspace/artifacts/design.md`, createdAt: now },
        { id: "plan-1", type: "plan", version: 1, sha256: digestOf(`# Plan\n\nGoal: fix retry handling.\n\n1. Fix it\n${"P".repeat(2_000)}`), producer: "test", objectKey: `private/${saved.ownerKey}/${saved.workspaceId}/artifacts/plan.md`, createdAt: now },
      ] };
    });
    harness.s3.objects.set(`private/${"0".repeat(64)}/other-workspace/artifacts/design.md`, elsewhere);
    const owner = await open(MAYA);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).not.toContain("From another task.");
    expect(owner.body).toContain("The saved design couldn't be verified, so it isn't shown.");
    expect(owner.body).toContain("The saved requirements couldn't be verified, so it isn't shown.");
    expect(owner.body).toContain("P".repeat(2_000));
  });

  it("shows only the latest review of each kind for the current code, and a check whose result is unknown as 'Couldn't tell'", async () => {
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const review = (role: "CRITIC" | "SECURITY", text: string, recordedAt: string) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "t", version: "1",
      status: "FINDINGS", findings: [{ text, origin: "INTRODUCED" }], readOnly: true, recordedAt });
    const { open } = await sharedPlanTask(() => ({ stage: "REVIEW", state: "BLOCKED", candidate,
      checkPolicy: { required: [{ id: "unit", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] },
      verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: "2026-10-08T00:00:00.000Z", results: [{ checkId: "unit", status: "UNKNOWN" }] },
      reviews: [review("CRITIC", "Retried away", "2026-10-08T00:00:00.000Z"), review("CRITIC", "Latest code finding", "2026-10-08T01:00:00.000Z")] }));
    const owner = await open(MAYA);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain("Latest code finding");
    expect(owner.body).not.toContain("Retried away");
    expect(owner.body).toContain("npm test: Couldn't tell");
  });

  it("shows the owner and a member of the task's channel the full document, and hides it from anyone else", async () => {
    const { plan, open } = await sharedPlanTask();
    const owner = await open(MAYA);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain("P".repeat(2_000));
    expect(owner.body).toContain("Waiting for your approval");
    const member = await open(TEAMMATE);
    expect(member.statusCode).toBe(200);
    expect(member.body).toContain(plan.split("\n")[2]);
    const stranger = await open(OMAR);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).not.toContain("retry");
  });

  it("drops a document whose saved copy changed, and says so", async () => {
    const { harness, objectKey, open } = await sharedPlanTask();
    harness.s3.objects.set(objectKey, "# Plan\n\nSomething else entirely.");
    const owner = await open(MAYA);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).not.toContain("Something else entirely.");
    expect(owner.body).toContain("The saved coding plan couldn't be verified, so it isn't shown.");
  });
});
