// A task with structured documents in a fake State table, and the route dependencies the task page's comment and access
// code needs: the owner (Priya), a channel member who can use the project (Sam), and a reader outside the channel (Omar).
import { createHash } from "node:crypto";
import { vi } from "vitest";
import { WorkflowSnapshotSchema, canonicalPlanJson, createWorkflowSnapshot, type PlanDocument, type WorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { planDocument } from "./plan-documents.js";
import { validatingDocumentClient } from "./validating-document-client.js";

export const TEAM = "T0PAGE001";
export const CHANNEL = "C0PAGE001";
export const OWNER_KEY = "a".repeat(64);
export const PRIYA: DeveloperCaller = { developerId: "d".repeat(64), sessionId: "s-priya", amr: "slack", name: "Priya Shah", slackUserId: "U0PRIYA01" };
export const SAM: DeveloperCaller = { developerId: "e".repeat(64), sessionId: "s-sam", amr: "slack", name: "Sam Lee", slackUserId: "U0SAM0001" };
export const OMAR: DeveloperCaller = { developerId: "f".repeat(64), sessionId: "s-omar", amr: "slack", name: "Omar Diaz", slackUserId: "U0OMAR001" };
export const START = Date.parse("2026-10-11T10:00:00.000Z");

/** A coding plan with claims 1, 2 and 2.1, decision d1 on 2.1 (Above or Below, AgentX recommends Below) and one proposed check. */
export function pagePlan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return planDocument({
    claims: [
      { id: "1", text: "Payments that fail with a timeout are retried." },
      { id: "2", text: "The retry banner sits on the page.", children: [{ id: "2.1", text: "It is placed near the pay button." }] },
    ],
    decisions: [{
      id: "d1", claimId: "2.1", question: "Where does the banner go?",
      options: [{ id: "above", label: "Above", consequence: "Seen first." }, { id: "below", label: "Below", consequence: "Less in the way." }],
      recommended: "below",
    }],
    checks: { proposed: [{ id: "retry-tests", label: "Retry tests", command: { cwd: "repo/demo", executable: "npx", args: ["vitest", "run"], timeoutSeconds: 120 } }], proves: { "retry-tests": ["1"] } },
    ...overrides,
  });
}

export interface PageTaskFixture {
  db: FakeDynamoDb;
  objects: Map<string, string>;
  deps: DeveloperTaskRouteDependencies;
  taskId: string;
  setNow(ms: number): void;
  advance(ms: number): void;
  /** Stores another version of `type` (structured unless `markdown` is given) and leaves the task waiting on it. */
  addVersion(type: "requirements" | "design" | "plan", content: PlanDocument | string): WorkflowArtifact;
  workflow(): WorkflowSnapshot;
  setWorkflow(workflow: WorkflowSnapshot): void;
  close(): void;
  members: Set<string>;
}

let counter = 0;

/** A Quick task (or Full with `path`) owned by Priya, shared into the channel, with no documents until `addVersion`. */
export function pageTask(options: { path?: "QUICK" | "FULL"; reviewPhase?: "REQUIREMENTS" | "DESIGN" | "IMPLEMENTATION_PLAN"; shared?: boolean } = {}): PageTaskFixture {
  counter += 1;
  const db = new FakeDynamoDb({ mapOrder: "dynamodb" });
  const objects = new Map<string, string>();
  const members = new Set([PRIYA.slackUserId!, SAM.slackUserId!]);
  let now = START;
  const taskId = `8b579b4b-eaa7-4bf2-87bc-${String(counter).padStart(12, "0")}`;
  const workspaceId = `4c1f5d7e-4ab0-4d43-9c55-${String(counter).padStart(12, "0")}`;
  const iso = () => new Date(now).toISOString();
  const initial = createWorkflowSnapshot({
    taskId, ownerId: OWNER_KEY, now: iso(), path: options.path ?? "QUICK",
    checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 120 } }], optional: [], selectedOptionalIds: [] },
  });
  const phase = options.reviewPhase ?? (options.path === "FULL" ? "REQUIREMENTS" : undefined);
  db.set({
    pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, developerId: PRIYA.developerId, provider: "slack", developerName: PRIYA.name,
    slackUserId: PRIYA.slackUserId, client: "slack", project: "payments", title: "Retry failed payments", workspaceId, ownerKey: OWNER_KEY,
    conversationId: "conversation", startingRevision: 1, charge: { member: { pk: "x", sk: "y" }, organization: { pk: "x", sk: "z" } },
    shared: options.shared !== false, ...(options.shared === false ? {} : { share: { teamId: TEAM, channelId: CHANNEL, mode: "view", sharedReason: "requested", sharedAt: iso(), threadTs: "1760000000.000100" } }),
    createdAt: iso(), updatedAt: iso(), workflow: WorkflowSnapshotSchema.parse({ ...initial, ...(phase === undefined ? {} : { reviewPhase: phase }) }),
  });
  const record = () => db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
  const setWorkflow = (workflow: WorkflowSnapshot) => db.set({ ...record(), workflow: WorkflowSnapshotSchema.parse(workflow) });
  const deps: DeveloperTaskRouteDependencies = {
    documentClient: validatingDocumentClient(db), tableName: "state", slackTeamId: TEAM,
    actions: {
      readArtifact: async (objectKey: string) => {
        const text = objects.get(objectKey);
        if (text === undefined) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return text;
      },
      operations: async () => [],
    } as unknown as DeveloperTaskRouteDependencies["actions"],
    checkAccess: vi.fn(async () => ({ revision: 1, policy: {} as never, access: "channel" as const, channelIds: [CHANNEL] })),
    channelMember: vi.fn(async (slackUserId: string) => members.has(slackUserId)),
    projectChannelIds: async () => [CHANNEL],
    now: () => now,
    log: vi.fn(),
  };
  return {
    db, objects, deps, taskId, members,
    setNow: (ms) => { now = ms; },
    advance: (ms) => { now += ms; },
    workflow: () => record().workflow,
    setWorkflow,
    close: () => db.set({ ...record(), closedAt: iso() }),
    addVersion: (type, content) => {
      const workflow = record().workflow;
      const version = workflow.artifacts.filter((artifact) => artifact.type === type).length + 1;
      const text = typeof content === "string" ? content : canonicalPlanJson(content);
      const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
      const objectKey = `private/${OWNER_KEY}/${workspaceId}/${type}-v${version}.${typeof content === "string" ? "md" : "json"}`;
      objects.set(objectKey, text);
      const artifact: WorkflowArtifact = {
        id: `${type}-v${version}`, type, version, sha256, producer: "agentx-planner", objectKey, createdAt: iso(),
        ...(typeof content === "string" ? {} : { format: "structured" as const }),
      };
      setWorkflow({ ...workflow, revision: workflow.revision + 1, stage: "PLAN_REVIEW", state: "WAITING", artifacts: [...workflow.artifacts, artifact], updatedAt: iso() });
      return artifact;
    },
  };
}
