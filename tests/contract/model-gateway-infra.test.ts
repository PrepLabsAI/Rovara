import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_COMPANY_KEY_PREFIX,
  GATEWAY_ENV,
  GATEWAY_COMPANY_SETTINGS,
  GATEWAY_LEDGER_INDEXES,
  GATEWAY_METER_INDEXES,
  GATEWAY_LOG_EVENTS,
  GATEWAY_MARKERS_TTL_ATTRIBUTE,
  GATEWAY_PORT,
  GATEWAY_TABLE_KEYS,
  type GatewayDependencies,
} from "../../packages/model-gateway/src/index.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import {
  MODEL_GATEWAY_ALARMS,
  MODEL_GATEWAY_CALL_CEILING_SECONDS,
  MODEL_GATEWAY_COMPANY_KEY_PREFIX,
  MODEL_GATEWAY_CONTEXT_KEY,
  MODEL_GATEWAY_ENV,
  MODEL_GATEWAY_COMPANY_PARTITION_PREFIX,
  MODEL_GATEWAY_LEDGER_INDEXES,
  MODEL_GATEWAY_METER_INDEXES,
  MODEL_GATEWAY_LOG_EVENTS,
  MODEL_GATEWAY_MARKERS_TTL_ATTRIBUTE,
  MODEL_GATEWAY_PORT,
  MODEL_GATEWAY_PRICE_FETCH_SCHEDULE,
  VALIDATE_KEY_ACCESS_VERSION,
} from "../../infra/lib/model-gateway.js";
import { CALL_HARD_CEILING_MS } from "../../packages/model-gateway/src/provider.js";

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>>; Principal?: unknown };

const app = buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: "staging", agentxRegion: "us-west-2" });
const gatewayStack = app.node.findChild("RovaraModelGateway") as Stack;
const template = Template.fromStack(gatewayStack);
const resources = template.toJSON().Resources as Record<string, Resource>;
const ofType = (type: string) => Object.entries(resources).filter(([, each]) => each.Type === type);
const idOf = (type: string, where: (properties: Record<string, unknown>) => boolean = () => true) => ofType(type).find(([, each]) => where(each.Properties))![0];
const actions = (statement: Statement) => [statement.Action].flat();
const policiesOf = (roleId: string): Statement[] => ofType("AWS::IAM::Policy")
  .filter(([, each]) => JSON.stringify(each.Properties.Roles).includes(`"${roleId}"`))
  .flatMap(([, each]) => (each.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
const allStatements: Statement[] = ofType("AWS::IAM::Policy").flatMap(([, each]) => (each.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
const tableId = (logical: string) => ofType("AWS::DynamoDB::GlobalTable").find(([id]) => id.startsWith(logical))![0];
const taskId = (logical: string) => ofType("AWS::ECS::TaskDefinition").find(([id]) => id.startsWith(logical))![0];
const containers = (taskLogical: string) => resources[taskId(taskLogical)]!.Properties.ContainerDefinitions as Array<Record<string, unknown>>;
const envOf = (taskLogical: string) => Object.fromEntries((containers(taskLogical)[0]!.Environment as Array<{ Name: string; Value: unknown }>).map((each) => [each.Name, each.Value]));
const serveRole = ofType("AWS::IAM::Role").find(([id]) => id.startsWith("ServeTaskRole"))![0];
const fetchRole = ofType("AWS::IAM::Role").find(([id]) => id.startsWith("PriceFetchTaskRole"))![0];

describe("model gateway infrastructure (plan v3.2 7.4, 7.5)", () => {
  it("is made only for a named environment, never by the Cloud release context", () => {
    expect(app.node.children.filter((child) => child instanceof Stack).map((child) => child.node.id).sort()).toEqual(["RovaraModelGateway", "RovaraModelGatewayImages"]);
    expect(gatewayStack.stackName).toBe("rovara-cloud-staging-gateway");
    // That Cloud's own release pipeline never deploys the gateway is pinned in Rovara Cloud, where that pipeline lives (#1478).
    expect(() => buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: "" })).toThrow(/must name/u);
    expect(() => buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: "Not A Name" })).toThrow(/invalid environment name/u);
  });

  it("repeats the process's literals exactly (deploy.ts)", () => {
    expect(MODEL_GATEWAY_ENV).toEqual(GATEWAY_ENV);
    expect(MODEL_GATEWAY_PORT).toBe(GATEWAY_PORT);
    expect(MODEL_GATEWAY_COMPANY_KEY_PREFIX).toBe(GATEWAY_COMPANY_KEY_PREFIX);
    expect(MODEL_GATEWAY_MARKERS_TTL_ATTRIBUTE).toBe(GATEWAY_MARKERS_TTL_ATTRIBUTE);
    expect(MODEL_GATEWAY_LOG_EVENTS).toEqual(GATEWAY_LOG_EVENTS);
    expect(MODEL_GATEWAY_LEDGER_INDEXES).toEqual(GATEWAY_LEDGER_INDEXES);
    expect(MODEL_GATEWAY_METER_INDEXES).toEqual(GATEWAY_METER_INDEXES);
    expect(MODEL_GATEWAY_COMPANY_PARTITION_PREFIX).toBe(GATEWAY_COMPANY_SETTINGS.partitionPrefix);
    // server.ts's own log events: a rename there fails to compile here.
    const serverEvents: Array<Parameters<GatewayDependencies["log"]>[0]["event"]> = [GATEWAY_LOG_EVENTS.refused, GATEWAY_LOG_EVENTS.overrunBusy, GATEWAY_LOG_EVENTS.settleFailed, GATEWAY_LOG_EVENTS.providerError];
    expect(serverEvents).toHaveLength(4);
    // A release drains for as long as the longest call, and a quiet stream is never cut before it.
    expect(MODEL_GATEWAY_CALL_CEILING_SECONDS * 1000).toBe(CALL_HARD_CEILING_MS);
  });

  it("serves two copies at all times behind HTTPS only, and a release cuts no call", () => {
    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 2, LaunchType: "FARGATE", EnableExecuteCommand: false,
      DeploymentConfiguration: { MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true } },
    });
    const service = ofType("AWS::ECS::Service")[0]![1].Properties as { NetworkConfiguration: { AwsvpcConfiguration: { Subnets: unknown[] } } };
    expect(service.NetworkConfiguration.AwsvpcConfiguration.Subnets).toHaveLength(2);
    const listeners = ofType("AWS::ElasticLoadBalancingV2::Listener").map(([, each]) => each.Properties);
    expect(listeners).toEqual([expect.objectContaining({ Port: 443, Protocol: "HTTPS", SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06", Certificates: [{ CertificateArn: { Ref: "CertificateArn" } }] })]);
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/healthz", Port: GATEWAY_PORT,
      TargetGroupAttributes: [{ Key: "deregistration_delay.timeout_seconds", Value: String(MODEL_GATEWAY_CALL_CEILING_SECONDS) }, { Key: "stickiness.enabled", Value: "false" }],
    });
    const alb = ofType("AWS::ElasticLoadBalancingV2::LoadBalancer")[0]![1].Properties.LoadBalancerAttributes as Array<{ Key: string; Value: string }>;
    expect(alb).toEqual(expect.arrayContaining([{ Key: "idle_timeout.timeout_seconds", Value: String(MODEL_GATEWAY_CALL_CEILING_SECONDS) }, { Key: "routing.http.drop_invalid_header_fields.enabled", Value: "true" }]));
    // The tasks take traffic from the load balancer only.
    const taskGroup = idOf("AWS::EC2::SecurityGroup", (p) => String(p.GroupDescription).startsWith("model gateway tasks"));
    const ingress = ofType("AWS::EC2::SecurityGroupIngress").map(([, each]) => each.Properties).filter((p) => JSON.stringify(p.GroupId).includes(taskGroup));
    expect(ingress).toEqual([expect.objectContaining({ FromPort: GATEWAY_PORT, ToPort: GATEWAY_PORT, SourceSecurityGroupId: { "Fn::GetAtt": [idOf("AWS::EC2::SecurityGroup", (p) => String(p.GroupDescription).startsWith("model gateway load balancer")), "GroupId"] } })]);
    const taskGroupProps = resources[taskGroup]!.Properties;
    expect(taskGroupProps.SecurityGroupIngress).toBeUndefined();
  });

  it("pins Code's one issuer and its task-key IDs, and runs the image by digest", () => {
    const env = envOf("ServeTask");
    expect(env[GATEWAY_ENV.installIssuer]).toEqual({ "Fn::Join": ["", [{ Ref: "CodeUrl" }, "/v1/auth"]] });
    expect(env[GATEWAY_ENV.installJwksUrl]).toEqual({ "Fn::Join": ["", [{ Ref: "CodeUrl" }, "/v1/auth/.well-known/jwks.json"]] });
    expect(env[GATEWAY_ENV.installTaskKids]).toEqual({ Ref: "CodeTaskKeyIds" });
    expect(env[GATEWAY_ENV.mode]).toBe("serve");
    const parameters = template.toJSON().Parameters as Record<string, { AllowedPattern?: string }>;
    expect(new RegExp(parameters.CodeTaskKeyIds!.AllowedPattern!, "u").test("abcdefghijklmnop,ABCDEFGHIJKLMNOP")).toBe(true);
    expect(new RegExp(parameters.CodeTaskKeyIds!.AllowedPattern!, "u").test("a,b,c")).toBe(false);
    expect(new RegExp(parameters.CodeUrl!.AllowedPattern!, "u").test("http://code.example")).toBe(false);
    expect(new RegExp(parameters.ImageDigest!.AllowedPattern!, "u").test("latest")).toBe(false);
    expect(JSON.stringify(containers("ServeTask")[0]!.Image)).toContain('"@",{"Ref":"ImageDigest"}');
    expect(containers("ServeTask")[0]).toMatchObject({ ReadonlyRootFilesystem: true, User: "1000:1000" });
  });

  it("keeps money rows with no expiry, expires only markers, all kept and recoverable", () => {
    const tables = ofType("AWS::DynamoDB::GlobalTable");
    expect(tables.map(([id]) => id.replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual(["Ledger", "Markers", "Meter", "Prices"]);
    for (const [id, each] of tables) {
      expect(each.Properties.KeySchema).toEqual([{ AttributeName: GATEWAY_TABLE_KEYS.partitionKey, KeyType: "HASH" }, { AttributeName: GATEWAY_TABLE_KEYS.sortKey, KeyType: "RANGE" }]);
      expect(each.DeletionPolicy).toBe("Retain");
      expect(each.Properties.Replicas).toEqual([expect.objectContaining({ DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })]);
      if (id.startsWith("Markers")) expect(each.Properties.TimeToLiveSpecification).toEqual({ AttributeName: GATEWAY_MARKERS_TTL_ATTRIBUTE, Enabled: true });
      else expect(each.Properties.TimeToLiveSpecification).toBeUndefined();
      // The ledger's two pending-correction indexes and the meter's open-holds index, keyed exactly as dynamo-meter.ts queries them.
      const expectedIndexes = id.startsWith("Ledger") ? Object.values(GATEWAY_LEDGER_INDEXES) : id.startsWith("Meter") ? Object.values(GATEWAY_METER_INDEXES) : [];
      if (expectedIndexes.length > 0) {
        expect(each.Properties.GlobalSecondaryIndexes).toEqual(expectedIndexes.map((index) => ({
          IndexName: index.name, Projection: { ProjectionType: "ALL" },
          KeySchema: [{ AttributeName: index.partitionKey, KeyType: "HASH" }, { AttributeName: index.sortKey, KeyType: "RANGE" }],
        })));
      } else expect(each.Properties.GlobalSecondaryIndexes).toBeUndefined();
    }
  });

  it("grants the serving role company keys only on the company tables, no deletes of money rows, no wildcard on tables or secrets", () => {
    const statements = policiesOf(serveRole);
    const bySid: Record<string, Statement> = Object.fromEntries(statements.map((each): [string, Statement] => [each.Sid ?? "", each]));
    const companyKeys = { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${GATEWAY_COMPANY_KEY_PREFIX}*`] }, Null: { "dynamodb:LeadingKeys": "false" } };
    expect(bySid.MeterAndLedgerCompanyKeys).toMatchObject({ Condition: companyKeys, Resource: [{ "Fn::GetAtt": [tableId("Meter"), "Arn"] }, { "Fn::GetAtt": [tableId("Ledger"), "Arn"] }] });
    expect(actions(bySid.MeterAndLedgerCompanyKeys!).sort()).toEqual(["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]);
    expect(bySid.MarkersCompanyKeys).toMatchObject({ Condition: companyKeys, Resource: { "Fn::GetAtt": [tableId("Markers"), "Arn"] } });
    expect(bySid.ReadPrices).toMatchObject({ Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: { "Fn::GetAtt": [tableId("Prices"), "Arn"] } });
    expect(Object.keys(bySid).sort()).toEqual(["DecryptProviderKeys", "MarkersCompanyKeys", "MeterAndLedgerCompanyKeys", "QueryOpenHolds", "QueryPendingCorrections", "ReadCompanyBudgets", "ReadInstallRovaraAi", "ReadPrices", "ReadProviderKeys"]);
    expect(bySid.QueryOpenHolds).toMatchObject({ Action: "dynamodb:Query", Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": [tableId("Meter"), "Arn"] }, `/index/${GATEWAY_METER_INDEXES.openHolds.name}`]] } });
    // Budgets: GetItem only, the named Companies table only, the backend's COMPANY# keys only.
    expect(bySid.ReadCompanyBudgets).toMatchObject({
      Action: "dynamodb:GetItem",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":dynamodb:us-west-2:", { Ref: "AWS::AccountId" }, ":table/", { Ref: "CompanyTableName" }]] },
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${GATEWAY_COMPANY_SETTINGS.partitionPrefix}*`] }, Null: { "dynamodb:LeadingKeys": "false" } },
    });
    expect(envOf("ServeTask")[GATEWAY_ENV.companyTable]).toEqual({ Ref: "CompanyTableName" });
    // The pending-correction indexes: Query only, the two indexes by name (no table, no wildcard, no write).
    expect(bySid.QueryPendingCorrections).toMatchObject({ Action: "dynamodb:Query", Resource: Object.values(GATEWAY_LEDGER_INDEXES).map((index) => ({ "Fn::Join": ["", [{ "Fn::GetAtt": [tableId("Ledger"), "Arn"] }, `/index/${index.name}`]] })) });
    expect(bySid.QueryPendingCorrections!.Condition).toBeUndefined();
    // Every table grant in the stack, for every role: named tables (and the two named ledger indexes) only, never a wildcard or a destructive action on money tables.
    for (const statement of allStatements.filter((each) => actions(each).some((action) => action.startsWith("dynamodb:")))) {
      expect(JSON.stringify(statement.Resource)).not.toContain("*");
      expect(actions(statement).every((action) => !action.includes("*") && !["dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:DeleteTable"].includes(action))).toBe(true);
      if (actions(statement).includes("dynamodb:DeleteItem")) expect(statement.Resource).toEqual({ "Fn::GetAtt": [tableId("Markers"), "Arn"] });
    }
    for (const statement of allStatements.filter((each) => actions(each).some((action) => action.startsWith("secretsmanager:")))) {
      expect(actions(statement)).toEqual(["secretsmanager:GetSecretValue"]);
      expect(statement.Resource).toEqual({ Ref: idOf("AWS::SecretsManager::Secret") });
    }
    expect(allStatements.filter((each) => actions(each).some((action) => action.startsWith("secretsmanager:") || action.startsWith("kms:")))).toEqual([bySid.ReadProviderKeys, bySid.DecryptProviderKeys]);
    expect(bySid.DecryptProviderKeys).toMatchObject({ Action: "kms:Decrypt", Resource: { "Fn::GetAtt": [idOf("AWS::KMS::Key"), "Arn"] }, Condition: { StringEquals: { "kms:ViaService": "secretsmanager.us-west-2.amazonaws.com" } } });
    // No model grant: the gateway calls providers with keys; Bedrock is a later route.
    expect(JSON.stringify(allStatements)).not.toMatch(/bedrock:|iam:\*|"\*:\*"|"Action":"\*"/u);
  });

  it("gives the price job the prices table only: no keys, no meter, no ledger, no markers", () => {
    const statements = policiesOf(fetchRole);
    expect(statements).toEqual([expect.objectContaining({ Sid: "WritePrices", Resource: { "Fn::GetAtt": [tableId("Prices"), "Arn"] } })]);
    const env = envOf("PriceFetchTask");
    expect(Object.keys(env).sort()).toEqual([GATEWAY_ENV.mode, GATEWAY_ENV.pricesTable, "NODE_OPTIONS"].sort());
    expect(env[GATEWAY_ENV.mode]).toBe("price-fetch");
  });

  it("holds no plaintext secret: keys are read by ARN at run time, the key policy lets only the serving role decrypt", () => {
    const text = JSON.stringify(template.toJSON());
    expect(text).not.toContain("{{resolve:secretsmanager");
    expect(text).not.toMatch(/sk-ant-|-----BEGIN|"SecretString"/u);
    for (const task of ["ServeTask", "PriceFetchTask"]) for (const container of containers(task)) expect(container.Secrets).toBeUndefined();
    expect(envOf("ServeTask")[GATEWAY_ENV.anthropicKeySecret]).toEqual({ Ref: idOf("AWS::SecretsManager::Secret") });
    template.hasResource("AWS::SecretsManager::Secret", {
      DeletionPolicy: "Retain",
      Properties: { KmsKeyId: { "Fn::GetAtt": [idOf("AWS::KMS::Key"), "Arn"] }, GenerateSecretString: { PasswordLength: 32, ExcludePunctuation: true } },
    });
    // Generated names (the default, DEC: a fixed name stays reserved after a failed create): no Name, so CloudFormation picks one.
    expect(Object.keys(resources[idOf("AWS::SecretsManager::Secret")]!.Properties)).not.toContain("Name");
    template.hasResource("AWS::KMS::Key", { DeletionPolicy: "Retain" });
    const keyPolicy = (ofType("AWS::KMS::Key")[0]![1].Properties.KeyPolicy as { Statement: Statement[] }).Statement;
    const decrypting = keyPolicy.filter((each) => actions(each).some((action) => /^kms:(Decrypt|ReEncrypt|CreateGrant|Create\*|\*)/u.test(action)));
    const secretArn = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":secretsmanager:us-west-2:", { Ref: "AWS::AccountId" }, ":secret:*"]] };
    const viaSecretsManager = { "kms:ViaService": "secretsmanager.us-west-2.amazonaws.com" };
    expect(decrypting).toEqual([
      // Only Secrets Manager's key-access check (the deploy's CreateSecret needs it); it opens no stored version.
      expect.objectContaining({
        Sid: "ValidateKeyAccessOnly", Action: "kms:Decrypt",
        Condition: { StringEquals: { ...viaSecretsManager, "kms:EncryptionContext:SecretVersionId": VALIDATE_KEY_ACCESS_VERSION }, StringLike: { "kms:EncryptionContext:SecretARN": secretArn } },
      }),
      // A stored value: the serving role only, through Secrets Manager, for the provider secrets only.
      expect.objectContaining({
        Sid: "OnlyGatewayReads", Action: "kms:Decrypt",
        Condition: { StringEquals: viaSecretsManager, StringLike: { "kms:EncryptionContext:SecretARN": secretArn }, ArnEquals: { "aws:PrincipalArn": { "Fn::GetAtt": [serveRole, "Arn"] } } },
      }),
    ]);
    // Policy edits stay with account administrators (someone must hold them, or the key is locked out); no other statement has them.
    expect(keyPolicy.filter((each) => actions(each).some((action) => /^kms:(Put|\*)/u.test(action))).map((each) => each.Sid)).toEqual(["AccountManagesNotUses"]);
    const storing = keyPolicy.find((each) => each.Sid === "OperatorsStoreNotRead")!;
    expect(actions(storing)).toEqual(["kms:GenerateDataKey", "kms:Encrypt"]);
  });

  it("lets ECS assume the task and execution roles only for this account's tasks (confused deputy)", () => {
    const ecsRoles = ofType("AWS::IAM::Role").filter(([, each]) => JSON.stringify(each.Properties.AssumeRolePolicyDocument).includes("ecs-tasks.amazonaws.com"));
    expect(ecsRoles.map(([id]) => id.replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual(["PriceFetchExecutionRole", "PriceFetchTaskRole", "ServeExecutionRole", "ServeTaskRole"]);
    for (const [, role] of ecsRoles) {
      const [trust] = (role.Properties.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement;
      expect(trust!.Condition).toEqual({
        ArnLike: { "aws:SourceArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ecs:us-west-2:", { Ref: "AWS::AccountId" }, ":*"]] } },
        StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
      });
    }
  });

  it("runs the daily price fetch on its schedule (the process's price-fetch mode is wired)", () => {
    template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: MODEL_GATEWAY_PRICE_FETCH_SCHEDULE, State: "ENABLED" });
    const rule = ofType("AWS::Events::Rule")[0]![1].Properties as { Targets: Array<{ EcsParameters: { TaskDefinitionArn: unknown; TaskCount: number } }> };
    expect(rule.Targets).toHaveLength(1);
    expect(rule.Targets[0]!.EcsParameters).toMatchObject({ TaskCount: 1, TaskDefinitionArn: { Ref: taskId("PriceFetchTask") } });
  });

  it("alarms on 5xx, fewer than two healthy tasks, refusals, busy answers, settle failures and price-fetch failures", () => {
    const alarms = ofType("AWS::CloudWatch::Alarm").map(([, each]) => each.Properties);
    const topic = idOf("AWS::SNS::Topic");
    for (const alarm of alarms) expect(alarm.AlarmActions).toEqual([{ Ref: topic }]);
    const byMetric = (name: string) => alarms.find((alarm) => String(alarm.MetricName).startsWith(name));
    expect(byMetric("HTTPCode_Target_5XX_Count")).toMatchObject({ Threshold: MODEL_GATEWAY_ALARMS.target5xx, Namespace: "AWS/ApplicationELB" });
    expect(byMetric("HTTPCode_ELB_5XX_Count")).toMatchObject({ Threshold: MODEL_GATEWAY_ALARMS.loadBalancer5xx });
    expect(byMetric("HealthyHostCount")).toMatchObject({ Threshold: 2, ComparisonOperator: "LessThanThreshold", Statistic: "Minimum" });
    const filters = ofType("AWS::Logs::MetricFilter").map(([, each]) => each.Properties as { FilterPattern: string; LogGroupName: unknown; MetricTransformations: Array<{ MetricName: string }> });
    const serveLogs = ofType("AWS::Logs::LogGroup").find(([id]) => id.startsWith("ServeLogs"))![0];
    const fetchLogs = ofType("AWS::Logs::LogGroup").find(([id]) => id.startsWith("PriceFetchLogs"))![0];
    const expected: Array<[string, string, string, number]> = [
      ["Refusals", GATEWAY_LOG_EVENTS.refused, serveLogs, MODEL_GATEWAY_ALARMS.refusals],
      ["BusyAnswers", GATEWAY_LOG_EVENTS.overrunBusy, serveLogs, MODEL_GATEWAY_ALARMS.busy],
      ["SettleFailures", GATEWAY_LOG_EVENTS.settleFailed, serveLogs, MODEL_GATEWAY_ALARMS.settleFailed],
      ["PriceFetchFailures", GATEWAY_LOG_EVENTS.priceFetchFailed, fetchLogs, MODEL_GATEWAY_ALARMS.priceFetchFailed],
    ];
    for (const [name, event, group, threshold] of expected) {
      const filter = filters.find((each) => each.MetricTransformations[0]!.MetricName === `${name}-staging`)!;
      expect(filter.FilterPattern).toBe(name === "SettleFailures" ? '{ ($.event = "settle_failed") || ($.event = "customer_source_over_reservation") }' : `{ $.event = "${event}" }`);
      expect(filter.LogGroupName).toEqual({ Ref: group });
      expect(byMetric(`${name}-staging`)).toMatchObject({ Threshold: threshold, Statistic: "Sum" });
    }
    // Staleness: a daily math alarm that counts a day when the gateway reported (healthy-host samples) and no fetch was saved.
    const fetched = filters.find((each) => each.MetricTransformations[0]!.MetricName === "PricesFetched-staging")!;
    expect(fetched.FilterPattern).toBe(`{ $.event = "${GATEWAY_LOG_EVENTS.priceFetched}" }`);
    expect(fetched.LogGroupName).toEqual({ Ref: fetchLogs });
    const stale = alarms.find((alarm) => alarm.AlarmName === "rovara-cloud-staging-gateway-PricesStale")!;
    // Missing data must not breach (a new stack has no fetch log yet), but silence still counts once the gateway has reported.
    expect(stale).toMatchObject({ Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", EvaluationPeriods: 3, DatapointsToAlarm: 3, TreatMissingData: "notBreaching" });
    const queries = stale.Metrics as Array<{ Id: string; Expression?: string; ReturnData?: boolean; MetricStat?: { Metric: { MetricName: string }; Period: number; Stat: string } }>;
    const expression = queries.find((query) => query.Expression !== undefined)!;
    expect(queries.filter((query) => query.ReturnData === true).map((query) => query.Id)).toEqual([expression.Id]);
    expect(expression.Expression).toBe("IF(alive > 0, 1, 0) * IF(FILL(fetched, 0) < 1, 1, 0)");
    const alive = queries.find((query) => query.Id === "alive")!;
    expect(alive.MetricStat).toMatchObject({ Metric: { MetricName: "HealthyHostCount" }, Period: 86400, Stat: "SampleCount" });
    // Without both dimensions the metric would never have data and the alarm would stay silent.
    expect((alive.MetricStat as unknown as { Metric: { Dimensions: Array<{ Name: string }> } }).Metric.Dimensions.map((each) => each.Name).sort()).toEqual(["LoadBalancer", "TargetGroup"]);
    const fetchedQuery = queries.find((query) => query.Id === "fetched")!;
    expect(fetchedQuery.MetricStat).toMatchObject({ Metric: { MetricName: "PricesFetched-staging" }, Period: 86400, Stat: "Sum" });
    expect(Object.values(resources).some((each) => each.Type === "AWS::CloudWatch::Alarm" && each.Properties.TreatMissingData === "breaching")).toBe(false);
    expect(alarms).toHaveLength(8);
    expect(filters.some((filter) => filter.MetricTransformations[0]!.MetricName === "OpenRouterOverReservation-staging")).toBe(false);
  });

  it("lets CloudWatch publish to the alarm topic, from this account and this stack's alarms only, and keeps the SSL-only deny", () => {
    const topic = idOf("AWS::SNS::Topic");
    const policy = ofType("AWS::SNS::TopicPolicy").find(([, each]) => JSON.stringify(each.Properties.Topics) === JSON.stringify([{ Ref: topic }]))![1];
    const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    const deny = statements.find((statement) => statement.Effect === "Deny")!;
    expect(deny.Condition).toEqual({ Bool: { "aws:SecureTransport": "false" } });
    const allow = statements.filter((statement) => statement.Effect === "Allow");
    expect(allow).toHaveLength(1);
    expect(allow[0]).toMatchObject({ Principal: { Service: "cloudwatch.amazonaws.com" }, Action: "sns:Publish", Resource: { Ref: topic } });
    expect(allow[0]!.Condition!.StringEquals).toEqual({ "aws:SourceAccount": { Ref: "AWS::AccountId" } });
    expect(allow[0]!.Condition!.ArnLike).toEqual({ "aws:SourceArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":cloudwatch:us-west-2:", { Ref: "AWS::AccountId" }, ":alarm:rovara-cloud-staging-gateway-*"]] } });
    // Every alarm's name begins with that prefix, so the allow covers each of them.
    for (const [, each] of ofType("AWS::CloudWatch::Alarm")) expect(String(each.Properties.AlarmName)).toMatch(/^rovara-cloud-staging-gateway-/);
  });
});
