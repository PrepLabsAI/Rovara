import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

// #1148: production (the legacy template) has Code's core engine as a named environment does, switched OFF by default: the CoreEngine switch, the core dispatch and lessons
// queues under production's fixed names, the job schedules (disabled while the switch is off), the dispatcher's core consumer (disabled while off), the /v1/app/* route Rovara
// Cloud's project page and Inbox call, the saved environment images' registry side, the outbox stream's ORG# filter, and the task-token and policy-hook keys.

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
interface Template { Resources: Record<string, Resource>; Parameters: Record<string, { Default?: unknown; AllowedPattern?: string }>; Conditions: Record<string, unknown> }
const ofType = (template: Template, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);

describe("the core engine in the legacy (production) template (#1148)", () => {
  let template: Template;
  beforeAll(() => { template = buildAgentXApp().synth().getStackByName("AgentXControlPlane").template as Template; }, 300_000);

  it("has the CoreEngine switch, off by default", () => {
    expect(template.Parameters.CoreEngine).toMatchObject({ Default: "off" });
  });

  it("serves /v1/app/* through the broker, as a named environment does", () => {
    const routes = ofType(template, "AWS::ApiGatewayV2::Route").map(([, route]) => route.Properties.RouteKey);
    expect(routes).toContain("ANY /v1/app/{proxy+}");
  });

  it("names the core's queues for production, and enables its schedules and the dispatcher's core consumer only while the switch is on", () => {
    const queues = ofType(template, "AWS::SQS::Queue").map(([, queue]) => queue.Properties.QueueName).filter((name) => typeof name === "string");
    expect(queues).toEqual(expect.arrayContaining(["agentx-production-core-dispatch", "agentx-production-core-dispatch-dead", "agentx-production-lessons-reflect", "agentx-production-lessons-reflect-dead"]));
    const schedules = ofType(template, "AWS::Scheduler::Schedule").filter(([id]) => id.startsWith("CoreEngineJobs"));
    expect(schedules.length).toBeGreaterThan(0);
    for (const [id, schedule] of schedules) expect(JSON.stringify(schedule.Properties.State), id).toMatch(/Fn::If/u);
    const coreMappings = ofType(template, "AWS::Lambda::EventSourceMapping").filter(([, mapping]) => JSON.stringify(mapping.Properties.EventSourceArn).includes("CoreEngineJobsQueue"));
    expect(coreMappings).toHaveLength(1);
    expect(JSON.stringify(coreMappings[0]![1].Properties.Enabled)).toMatch(/Fn::If/u);
  });

  it("keeps core company rows (ORG#) away from the State stream's outbox publisher", () => {
    const outbox = ofType(template, "AWS::Lambda::EventSourceMapping").find(([id]) => id.startsWith("OutboxStreamMapping"))!;
    expect(JSON.stringify(outbox[1].Properties.FilterCriteria)).toContain('\\"anything-but\\":{\\"prefix\\":\\"ORG#\\"}');
  });

  it("has the saved environment images' registry side under rovara-env/production, and the task-token and policy-hook keys under production's aliases", () => {
    const creation = ofType(template, "AWS::ECR::RepositoryCreationTemplate");
    expect(creation.map(([, resource]) => resource.Properties.Prefix)).toEqual(["rovara-env/production"]);
    const aliases = ofType(template, "AWS::KMS::Alias").map(([, alias]) => alias.Properties.AliasName);
    expect(aliases).toEqual(expect.arrayContaining(["alias/agentx/production/task-tokens", "alias/agentx/production/policy-questions"]));
  });

  it("builds no name from an undefined environment", () => {
    expect(JSON.stringify(template)).not.toMatch(/undefined/u);
  });
});
