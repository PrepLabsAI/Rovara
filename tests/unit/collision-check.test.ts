import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stack } from "aws-cdk-lib";
import { describe, expect, it, vi } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { findCollisions, inputsFromDir, main, type Template } from "../../scripts/collision-check.js";
import { normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// Switch-over incident 2026-11-16: the staging update to code/next 1d40766b2 failed with 409 AlreadyExists because
// two new route logical IDs reused the route keys of live routes the same update removes (CloudFormation creates
// before its cleanup deletes). scripts/collision-check.ts finds that class of failure; these tests pin it.

const route = (routeKey: string, api = "HttpApi") => ({ Type: "AWS::ApiGatewayV2::Route", Properties: { ApiId: { Ref: api }, RouteKey: routeKey, AuthorizationType: "NONE" } });
const one = (live: Template, next: Template, stack = "s") => findCollisions([{ stack, live, next }]).collisions;

describe("collision-check", () => {
  it("reports a new logical ID that reuses a removed resource's route key", () => {
    const collisions = one({ Resources: { ModelAccessRoute: route("GET /m") } }, { Resources: { CoreModelAccessRoute: route("GET /m") } });
    expect(collisions).toStrictEqual([{
      kind: "removed-same-stack",
      key: "AWS::ApiGatewayV2::Route|ApiId=<ref:s/HttpApi>|RouteKey=GET /m",
      added: { stack: "s", id: "CoreModelAccessRoute", type: "AWS::ApiGatewayV2::Route" },
      existing: { stack: "s", id: "ModelAccessRoute", type: "AWS::ApiGatewayV2::Route" },
    }]);
  });

  it("is clean when the logical ID is kept, or the key differs, or the API differs", () => {
    expect(one({ Resources: { ModelAccessRoute: route("GET /m") } }, { Resources: { ModelAccessRoute: route("GET /m") } })).toStrictEqual([]);
    expect(one({ Resources: { A: route("GET /a") } }, { Resources: { B: route("GET /b") } })).toStrictEqual([]);
    expect(one({ Resources: { A: route("GET /a", "Api1") } }, { Resources: { B: route("GET /a", "Api2") } })).toStrictEqual([]);
  });

  it("reports a new logical ID that duplicates a kept resource's key", () => {
    const live = { Resources: { X: { Type: "AWS::SSM::Parameter", Properties: { Name: "/a" } } } };
    const next = { Resources: { X: { Type: "AWS::SSM::Parameter", Properties: { Name: "/a" } }, Y: { Type: "AWS::SSM::Parameter", Properties: { Name: "/a" } } } };
    expect(one(live, next).map((c) => c.kind)).toStrictEqual(["kept-duplicate"]);
  });

  it("counts a type change under the same logical ID as remove plus add", () => {
    const live = { Resources: { X: { Type: "AWS::SQS::Queue", Properties: { QueueName: "n" } }, Y: { Type: "AWS::SNS::Topic", Properties: { TopicName: "t" } } } };
    const next = { Resources: { X: { Type: "AWS::SNS::Topic", Properties: { TopicName: "t" } } } };
    expect(one(live, next).map((c) => `${c.kind} ${c.added.id}<-${c.existing.id}`)).toStrictEqual(["removed-same-stack X<-Y"]);
  });

  it("reports a kept logical ID whose key changes to a key a removed resource holds", () => {
    const collisions = one({ Resources: { A: route("GET /a"), B: route("GET /b") } }, { Resources: { A: route("GET /b") } });
    expect(collisions.map((c) => `${c.kind} ${c.added.id}<-${c.existing.id}`)).toStrictEqual(["kept-key-change A<-B"]);
    expect(one({ Resources: { A: route("GET /a"), B: route("GET /b") } }, { Resources: { A: route("GET /a") } })).toStrictEqual([]);
  });

  it("takes part a stack with only a live or only a new template, and fails closed on bad input", () => {
    const dir = mkdtempSync(join(tmpdir(), "collision-check-"));
    try {
      writeFileSync(join(dir, "old.live-template.json"), JSON.stringify({ Resources: { T: { Type: "AWS::DynamoDB::Table", Properties: { TableName: "t" } } } }));
      writeFileSync(join(dir, "new.template.json"), JSON.stringify({ Resources: { T2: { Type: "AWS::DynamoDB::Table", Properties: { TableName: "t" } } } }));
      const inputs = inputsFromDir(dir);
      expect(inputs.map((i) => i.stack)).toStrictEqual(["new", "old"]);
      expect(findCollisions(inputs).collisions.map((c) => c.kind)).toStrictEqual(["removed-other-stack"]);
      writeFileSync(join(dir, "new.template.json"), "{not json");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try { expect(main(["--dir", dir])).toBe(2); } finally { stderr.mockRestore(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves Fn::Sub, Fn::Join, parameters and the stack name before comparing", () => {
    const live: Template = { Resources: { OldAlarm: { Type: "AWS::CloudWatch::Alarm", Properties: { AlarmName: "agentx-staging-Errors" } } } };
    const next: Template = {
      Parameters: { Env: { Default: "staging" } },
      Resources: {
        SubAlarm: { Type: "AWS::CloudWatch::Alarm", Properties: { AlarmName: { "Fn::Sub": "agentx-${Env}-Errors" } } },
        JoinAlarm: { Type: "AWS::CloudWatch::Alarm", Properties: { AlarmName: { "Fn::Join": ["-", ["agentx", { Ref: "Env" }, "Errors"]] } } },
        StackAlarm: { Type: "AWS::CloudWatch::Alarm", Properties: { AlarmName: { "Fn::Sub": "${AWS::StackName}-Errors" } } },
      },
    };
    expect(findCollisions([{ stack: "agentx-staging", live, next }]).collisions.map((c) => c.added.id).sort()).toStrictEqual(["JoinAlarm", "StackAlarm", "SubAlarm"]);
  });

  it("uses live parameter values for the new template when it keeps the previous value", () => {
    const live: Template = { Resources: { Old: { Type: "AWS::SQS::Queue", Properties: { QueueName: "q-prod" } } } };
    const next: Template = { Parameters: { Name: {} }, Resources: { New: { Type: "AWS::SQS::Queue", Properties: { QueueName: { Ref: "Name" } } } } };
    expect(findCollisions([{ stack: "s", live, next, liveParams: { Name: "q-prod" } }]).collisions).toHaveLength(1);
    expect(findCollisions([{ stack: "s", live, next, liveParams: { Name: "q-prod" }, nextParams: { Name: "q-other" } }]).collisions).toHaveLength(0);
  });

  it("ignores generated names and types with no unique key", () => {
    const live = { Resources: { A: { Type: "AWS::SQS::Queue", Properties: {} }, K: { Type: "AWS::KMS::Key", Properties: { Description: "k" } } } };
    const next = { Resources: { B: { Type: "AWS::SQS::Queue", Properties: {} }, L: { Type: "AWS::KMS::Key", Properties: { Description: "k" } } } };
    const result = findCollisions([{ stack: "s", live, next }]);
    expect(result.collisions).toStrictEqual([]);
    expect(result.unclassifiedTypes).toStrictEqual(["AWS::KMS::Key"]);
  });

  it("reports a key moved to another stack, and a reused export name", () => {
    const result = findCollisions([
      { stack: "a", live: { Resources: { T: { Type: "AWS::DynamoDB::Table", Properties: { TableName: "t" } } }, Outputs: { O: { Export: { Name: "x" } } } }, next: { Resources: {} } },
      { stack: "b", live: { Resources: {} }, next: { Resources: { T2: { Type: "AWS::DynamoDB::Table", Properties: { TableName: "t" } } }, Outputs: { P: { Export: { Name: "x" } } } } },
    ]);
    expect(result.collisions.map((c) => `${c.kind} ${c.added.stack}/${c.added.id}<-${c.existing.stack}/${c.existing.id}`).sort()).toStrictEqual([
      "removed-other-stack b/Outputs.P<-a/Outputs.O",
      "removed-other-stack b/T2<-a/T",
    ]);
  });

  it("keys an inline policy by role, and a one-per-parent policy by its parent", () => {
    const policy = (role: string) => ({ Type: "AWS::IAM::Policy", Properties: { PolicyName: "p", Roles: [{ Ref: role }] } });
    expect(one({ Resources: { P1: policy("R1") } }, { Resources: { P2: policy("R1") } })).toHaveLength(1);
    expect(one({ Resources: { P1: policy("R1") } }, { Resources: { P2: policy("R2") } })).toHaveLength(0);
    const qp = { Type: "AWS::SQS::QueuePolicy", Properties: { Queues: [{ Ref: "Q" }] } };
    expect(one({ Resources: { QP1: qp } }, { Resources: { QP2: qp } })).toHaveLength(1);
  });
});

describe("named staging templates against the 0.5.18 staging live routes", () => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  const controlPlane = normalizedTemplate(stacks.find((stack) => stack.stackName === "agentx-staging-control-plane")!) as Template;

  it("keeps the deployed logical IDs of the model-access and developer app routes", () => {
    const resources = controlPlane.Resources!;
    expect(resources.ModelAccessRoute?.Properties?.RouteKey).toBe("GET /v1/internal/model-access");
    expect(resources.DeveloperSignInAppRouteBAD38FAA?.Properties?.RouteKey).toBe("ANY /v1/app/{proxy+}");
    expect(resources.CoreModelAccessRoute).toBeUndefined();
    expect(resources.DeveloperSignInCoreAppRoute6D4AEEF7).toBeUndefined();
  });

  it("adds no route whose key a removed live route still holds", () => {
    // Every HttpApi route of the live 0.5.18 staging control plane (logical ID + route key), from its live template.
    const live = (JSON.parse(readFileSync(new URL("../fixtures/switchover/staging-0518-control-plane-routes.json", import.meta.url), "utf8")) as Record<string, Template>)["agentx-staging-control-plane"]!;
    expect(Object.keys(live.Resources!)).toHaveLength(25);
    expect(findCollisions([{ stack: "agentx-staging-control-plane", live, next: controlPlane }]).collisions).toStrictEqual([]);
  });
});
