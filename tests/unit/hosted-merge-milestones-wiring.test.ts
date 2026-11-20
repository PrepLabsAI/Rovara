// Lead 4 L4-HW7: on the hosted root, the milestone service the merge-tracking job writes on is the company's own (the one lessons build and the thread and ticket handlers register on). The root is real (registry, runtime,
// lessons, chat threads); only the deployment adapters are fakes. Mutants are listed in the PR body with the test that kills each.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { codeMilestoneKey, companyScoped, type CodeMilestone, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createHostedLessonsPeople } from "../../packages/broker/src/aws/hosted-lessons-people.js";
import { hostedSlackThreads } from "../../packages/broker/src/aws/slack-thread-channel.js";
import { codeMilestoneItems } from "../../packages/broker/src/core/milestones/milestones.js";
import type { TaskFlow } from "../../packages/broker/src/core/task-flow/flow.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const secret = Buffer.alloc(32, 7);
const MEMBER_A = (1).toString(16).padStart(64, "0");

async function setup(options: { lessons?: string } = {}) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const rows = new Map<string, Record<string, unknown>>();
  rows.set(`signin|COMPANY_MEMBER#${MEMBER_A}|COMPANY`, { pk: `COMPANY_MEMBER#${MEMBER_A}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: MEMBER_A, companyId: A, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
  rows.set(`signin|${companyScoped(A, "MEMBERS")}|MEMBER#${MEMBER_A}`, { pk: companyScoped(A, "MEMBERS"), sk: `MEMBER#${MEMBER_A}`, entityType: "COMPANY_MEMBER_VIEW", personId: MEMBER_A, companyId: A, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
  const client = { async send(command: unknown) {
    if (command instanceof GetCommand) {
      const { TableName, Key } = command.input as { TableName: string; Key: { pk: string; sk: string } };
      if (TableName === "signin" || TableName === "state") return { Item: rows.get(`${TableName}|${Key.pk}|${Key.sk}`) };
      return { Item: await world.store.get(Key) };
    }
    if (command instanceof QueryCommand) {
      const input = command.input as { ExpressionAttributeValues: Record<string, string> };
      const pk = input.ExpressionAttributeValues[":pk"]!;
      const items = [...rows.entries()].filter(([k]) => k.startsWith(`signin|${pk}|`)).map(([, row]) => row);
      return { Items: items, ScannedCount: items.length };
    }
    throw new Error("unexpected write");
  } };
  const slackPosts: string[] = [];
  const flows = new Map<string, TaskFlow>();
  const jobs = new Map<string, ReturnType<typeof createHostedBrokerCoreServices>>();
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ...(options.lessons === undefined ? {} : { ROVARA_CORE_LESSONS: options.lessons }) },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    // The same builder the broker passes (aws/broker.ts), over the flow the root gives it.
    services: (companyId, flow, registry, wiring) => {
      flows.set(companyId, flow);
      const built = createHostedBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, ...(wiring.notification === undefined ? {} : { notification: wiring.notification }) });
      jobs.set(companyId, built);
      return { ...built, "admission-hold-sweep": { pass: async () => ({}) } };
    },
    lessonsPeople: createHostedLessonsPeople({ documentClient: client, stateTableName: "state", signInTableName: "signin", now: () => world.clock.now }),
    chatThreads: hostedSlackThreads({
      workspaces: { requireCompany: async () => A, tokenForCompany: async () => undefined },
      fetch: (async (url: string | URL, init?: RequestInit) => { slackPosts.push(`${String(url)} ${typeof init?.body === "string" ? init.body : ""}`); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as unknown as typeof fetch,
    }),
  });
  return { root, world, flows, jobs, slackPosts };
}
const milestoneOf = (companyId: OrgId, taskId: string): CodeMilestone => ({ kind: "merged", orgId: companyId, taskId, at: "2026-11-15T10:00:00.000Z", text: "The pull request was merged." });

describe("the hosted root's merge tracking writes on the company's milestone service", () => {
  it("with lessons on, the flow the jobs are built over carries the company's milestone service, with the hosted handlers registered on it", async () => {
    const { root, world, flows } = await setup({ lessons: "on" });
    await root.app.runtimeFor(A);
    const milestones = flows.get(A)!.deps.milestones;
    expect(milestones).toBeDefined();
    const taskId = "77777777-7777-4777-8777-777777777777";
    expect((await world.store.transact(codeMilestoneItems(milestoneOf(A, taskId), 1, { definitionVersion: "1.1.0" }))).applied).toBe(true);
    await milestones!.deliver(taskId);
    // The handlers the root registers for the company each ran (named attributes), and the row is settled by those runs.
    const row = (await world.store.get(codeMilestoneKey(taskId, "merged", 1)))!;
    for (const name of ["lessons", "team_record", "channel_thread"]) expect(row[`done_${name}`], name).toBe(true);
    expect(row["deliveredAt"]).toBeDefined();
  });

  it("the merge-tracking job of that company is built over that same flow (the service reads the company's milestones at pass time)", async () => {
    const { root, jobs } = await setup({ lessons: "on" });
    await root.app.runtimeFor(A);
    expect(await jobs.get(A)!["merge-tracking"].pass({ budgetMs: 1000 })).toMatchObject({ attempted: 0 });
  });
});

describe("the broker builds the hosted jobs with the company's flow", () => {
  const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
  it("passes the root's flow to createHostedBrokerCoreServices (the milestone service rides on it)", () => {
    expect(source).toMatch(/services: \(companyId, flow, registry, wiring\) => createHostedBrokerCoreServices\(\{ companyId, flow, registry,/u);
  });
  it("merge tracking reads the milestone service from the flow, not a fresh one made per pass", () => {
    const jobs = readFileSync(new URL("../../packages/broker/src/aws/core-job-services.ts", import.meta.url), "utf8");
    expect(jobs).toMatch(/flow\.deps\.milestones \?\? createMilestoneService/u);
    expect(jobs).not.toMatch(/milestones: createMilestoneService\(/u);
  });
});
