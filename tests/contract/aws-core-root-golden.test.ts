// Lane E2 step 6 golden: with the core switch off (the default), giving the AWS broker its core root changes nothing. The same script of developer requests and worker callbacks is run on
// a broker without the root and on one with it, and every answer and every row of the table is compared whole (ids and times are renamed in order of first appearance, since each run
// makes its own). The root reads nothing at all while off.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { brokerCoreModuleDeps, createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";

beforeAll(async () => { await loadSlackBroker(); });

const DIFF = ["## demo", "", "### status", " M src/retry.ts", "### diff", "diff --git a/src/retry.ts b/src/retry.ts", "--- a/src/retry.ts", "+++ b/src/retry.ts", "@@ -1 +1,2 @@", "-old", "+new", "+more", ""].join("\n");

/** Ids (UUIDs, 64-hex digests and signed tokens that differ per run) and times, renamed in order of first appearance; everything else kept byte for byte. */
function normalise(text: string): string {
  const seen = new Map<string, string>();
  const name = (prefix: string) => (value: string) => {
    let found = seen.get(value);
    if (found === undefined) seen.set(value, found = `<${prefix}${String(seen.size)}>`);
    return found;
  };
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, name("id"))
    .replace(/\b[0-9a-f]{64}\b/gu, name("hash"))
    // Signed capabilities and grants carry the run's own ids (base64url): a token of its shape, not its bytes.
    .replace(/[A-Za-z0-9_-]{40,}(?:\.[A-Za-z0-9_-]+)*/gu, "<token>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, "<time>")
    .replace(/"durationMs":\d+/gu, "\"durationMs\":<ms>")
    .replace(/"(?:expiresAt|indexExpiresAt|ttl|updatedAtEpoch|startedAtEpoch|endsAt|at)":\d{9,13}/gu, (match) => match.replace(/\d{9,13}/u, "<epoch>"));
}

async function script(withCore: boolean): Promise<{ answers: string[]; rows: string[]; coreReads: number }> {
  let coreReads = 0;
  const counting = { send: async () => { coreReads += 1; throw new Error("the off root must read nothing"); } };
  const root = withCore ? createBrokerCoreRoot({
    env: {}, documentClient: counting, stateTableName: "state", signInTableName: "signin", callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => { throw new Error("unused"); }, codeModules: () => brokerCoreModuleDeps({}), origin: () => "https://api.example", log: () => { coreReads += 1; },
  }) : undefined;
  const harness = await createDeveloperTaskBroker(root === undefined ? {} : { brokerExtra: { core: root } });
  const answers: string[] = [];
  const keep = (value: unknown) => answers.push(normalise(JSON.stringify(value)));
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
  keep(started);
  const taskId = (started.body.task as { taskId: string }).taskId;
  const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const active = () => String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  keep(await harness.finish(workspaceId, active(), "SUCCEEDED"));
  const operationId = active();
  keep(await harness.events(workspaceId, operationId, [{ type: "lifecycle", payload: { status: "RUNNING" } }, { type: "progress", payload: { message: "step 1" } }]));
  keep(await harness.artifact(workspaceId, operationId, "workspace.diff", DIFF));
  keep(await harness.finish(workspaceId, operationId, "SUCCEEDED"));
  for (const [who, method, path] of [[MAYA, "GET", `/v1/dev/tasks/${taskId}`], [MAYA, "GET", `/v1/dev/tasks/${taskId}/events?limit=5`], [MAYA, "GET", "/v1/dev/tasks"], [OMAR, "GET", `/v1/dev/tasks/${taskId}`],
    [MAYA, "GET", `/v1/dev/tasks/${randomUUID()}`], [OMAR, "POST", "/v1/dev/tasks"], [MAYA, "POST", `/v1/dev/tasks/${taskId}/close`]] as const) {
    keep(await harness.dev(who, method, path, method === "POST" && path === "/v1/dev/tasks" ? { requestId: randomUUID(), project: "payments", instructions: "Another", client: "claude-code" } : undefined));
  }
  // Lane L12: the core's /v1/app/* paths, which the broker answers only while the switch serves: off, exactly as without the root.
  for (const [method, path] of [["GET", "/v1/app/script-tokens"], ["POST", "/v1/app/script-tokens"], ["GET", "/v1/app/sessions"], ["GET", "/v1/app/decisions"], ["POST", `/v1/app/people/${OMAR.developerId}/erase`], ["GET", "/v1/app/projects/payments/how-we-work"]] as const) {
    keep(await harness.dev(MAYA, method, path, method === "POST" ? { requestId: randomUUID() } : undefined));
  }
  // Each row on its own (its ids renamed within the row), then sorted: the table's rows as a set, every byte but the ids and times compared.
  const rows = harness.db.find(() => true).map((item) => normalise(JSON.stringify(item))).sort();
  return { answers, rows, coreReads };
}

describe("the broker with its core root, switch off", () => {
  it("answers and writes byte for byte as the broker without it, and the root reads nothing", async () => {
    const without = await script(false);
    const withRoot = await script(true);
    expect(withRoot.answers).toEqual(without.answers);
    expect(withRoot.rows).toEqual(without.rows);
    expect(withRoot.coreReads).toBe(0);
  });
});
