// tests/contract/admin-change-infrastructure.test.ts
// Spec 025 phase 25e: every new grant is exact, the notifier's stream mapping gains one filter,
// and the legacy template does not change.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { INDEX_EXPIRY_ATTRIBUTE } from "@agentx/contracts";

type Statement = { Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
const statementsOf = (template: Template, rolePrefix: string) => (Object.values(template.findResources("AWS::IAM::Policy")) as Policy[])
  .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith(rolePrefix)))
  .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
const leading = (statement: Statement) => statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"];

describe("admin change infrastructure", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "ChangesControlPlane", { naming: environmentNaming("live25e") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "ChangesLegacyControlPlane"));

  it("adds one ADMIN_CHANGE filter to the notifier's existing stream mapping, and no third stream reader", () => {
    const mappings = Object.values(named.findResources("AWS::Lambda::EventSourceMapping")) as Array<{ Properties: { EventSourceArn?: unknown; FilterCriteria?: { Filters: Array<{ Pattern: string }> } } }>;
    const onStream = mappings.filter((mapping) => JSON.stringify(mapping.Properties.EventSourceArn).includes("StreamArn"));
    expect(onStream).toHaveLength(2);
    const patterns = onStream.flatMap((mapping) => mapping.Properties.FilterCriteria?.Filters ?? []).map((filter) => filter.Pattern);
    expect(patterns).toContainEqual(JSON.stringify({ dynamodb: { NewImage: { entityType: { S: ["ADMIN_CHANGE"] } } } }));
  });

  it("lets the notifier read and update ADMIN_CHANGE items only, by key", () => {
    const notifier = statementsOf(named, "DeveloperTaskNotifierFunctionServiceRole");
    expect(notifier).toContainEqual(expect.objectContaining({ Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"], Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ADMIN_CHANGE#*"] } } }));
  });

  it("lets the broker write audit records under CHANGE# only, and read the email index", () => {
    const broker = statementsOf(named, "BrokerServiceRole");
    expect(broker.find((statement) => JSON.stringify(leading(statement)) === JSON.stringify(["CHANGE#*"]))?.Action).toEqual(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"]);
    expect(broker.some((statement) => JSON.stringify(leading(statement) ?? []).includes("EMAIL#*"))).toBe(true);
  });

  it("lets the ingress read only an ADMIN_CHANGE item's keys and trace ID", () => {
    const ingress = statementsOf(named, "SlackIngressServiceRole");
    const read = ingress.find((statement) => JSON.stringify(leading(statement)) === JSON.stringify(["ADMIN_CHANGE#*"]));
    expect(read).toMatchObject({ Action: "dynamodb:GetItem", Condition: { "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "traceId"] }, Null: { "dynamodb:Attributes": "false" } } });
  });

  it("adds the McpConfirmElicitation parameter, enabled by default, to DeveloperIdentity and the broker", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters.McpConfirmElicitation).toMatchObject({ Type: "String", Default: "enabled", AllowedValues: ["enabled", "disabled"] });
    expect(JSON.stringify(named.toJSON())).toContain("MCP_CONFIRM_ELICITATION");
  });

  it("changes nothing in the legacy template", () => {
    expect(legacy.toJSON().Parameters).not.toHaveProperty("McpConfirmElicitation");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("ADMIN_CHANGE");
    for (const absent of ["MCP_CONFIRM_ELICITATION", "CHANGE#*", "EMAIL#*"]) expect(JSON.stringify(legacy.toJSON())).not.toContain(absent);
  });

  // Task 10 additions: the exact shape of each new statement, and where each variable goes.
  type Fn = { Properties: { Environment?: { Variables?: Record<string, unknown> }; Role?: { "Fn::GetAtt": [string, string] } } };
  const functionNamed = (template: Template, prefix: string) => Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, Fn>)
    .find(([id]) => id.replace(/[0-9A-F]{8}$/, "") === prefix)![1];
  const variablesOf = (template: Template, prefix: string) => functionNamed(template, prefix).Properties.Environment?.Variables ?? {};
  const keysOf = (statement: Statement) => leading(statement) as string[] | undefined;
  const tableRef = (template: Template, prefix: string) => {
    const [id] = Object.keys(template.findResources("AWS::DynamoDB::Table")).filter((logicalId) => logicalId.replace(/[0-9A-F]{8}$/, "") === prefix);
    return { "Fn::GetAtt": [id, "Arn"] };
  };

  it("gives the notifier's ADMIN_CHANGE statement the State table only, and no other statement of its names ADMIN_CHANGE", () => {
    const notifier = statementsOf(named, "DeveloperTaskNotifierFunctionServiceRole");
    const changes = notifier.filter((statement) => JSON.stringify(keysOf(statement) ?? []).includes("ADMIN_CHANGE"));
    expect(changes).toEqual([{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource: tableRef(named, "State"), Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ADMIN_CHANGE#*"] } } }]);
  });

  it("gives the broker's CHANGE# statement the TurnRecords table only, and appends EMAIL# to its sign-in table read", () => {
    const broker = statementsOf(named, "BrokerServiceRole");
    const changes = broker.filter((statement) => JSON.stringify(keysOf(statement) ?? []).includes("CHANGE#"));
    expect(changes).toEqual([{ Effect: "Allow", Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"], Resource: tableRef(named, "TurnRecords"), Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANGE#*"] } } }]);
    const emails = broker.filter((statement) => JSON.stringify(keysOf(statement) ?? []).includes("EMAIL#"));
    expect(emails).toEqual([{ Effect: "Allow", Action: "dynamodb:GetItem", Resource: tableRef(named, "DeveloperSignInTable"), Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*", "EMAIL#*"] } } }]);
  });

  it("gives the ingress's ADMIN_CHANGE statement the State table only, with the projection pinned", () => {
    const ingress = statementsOf(named, "SlackIngressServiceRole");
    const changes = ingress.filter((statement) => JSON.stringify(keysOf(statement) ?? []).includes("ADMIN_CHANGE"));
    expect(changes).toEqual([{
      Effect: "Allow", Action: "dynamodb:GetItem", Resource: tableRef(named, "State"),
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ADMIN_CHANGE#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "traceId"] },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        Null: { "dynamodb:Attributes": "false" },
      },
    }]);
  });

  it("turns the ingress press path on in the named template only", () => {
    expect(variablesOf(named, "SlackIngress")).toMatchObject({ ADMIN_CHANGES: "enabled" });
    expect(variablesOf(legacy, "SlackIngress")).not.toHaveProperty("ADMIN_CHANGES");
  });

  it("passes McpConfirmElicitation to DeveloperIdentity and the broker straight from the parameter", () => {
    for (const prefix of ["Broker", "DeveloperSignInFunction"]) expect(variablesOf(named, prefix).MCP_CONFIRM_ELICITATION).toEqual({ Ref: "McpConfirmElicitation" });
    expect(variablesOf(legacy, "Broker")).not.toHaveProperty("MCP_CONFIRM_ELICITATION");
  });

  it("expires admin change items by the State table's TTL in named environments", () => {
    const state = Object.entries(named.findResources("AWS::DynamoDB::Table")).find(([id]) => id.replace(/[0-9A-F]{8}$/, "") === "State")![1] as { Properties: Record<string, unknown> };
    expect(state.Properties.TimeToLiveSpecification).toEqual({ AttributeName: INDEX_EXPIRY_ATTRIBUTE, Enabled: true });
  });

  it("has no em dash in any parameter description", () => {
    for (const parameter of Object.values(named.toJSON().Parameters as Record<string, { Description?: string }>)) expect(parameter.Description ?? "").not.toContain("\u2014");
  });
});
