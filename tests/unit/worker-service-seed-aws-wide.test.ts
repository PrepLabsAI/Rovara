// Wide AWS plans: what Rovara creates from a project's declarations beyond buckets, queues and tables. SNS topics (subscribed to the declared queues), Secrets Manager secrets (a placeholder value, never one from the
// repository), SSM parameters (a plain String's literal default only; a SecureString or a StringList is not seeded), KMS keys with their alias, EventBridge buses and rules. The documents are the ones the front's seed accepts (its `seed.go`); every other service of the
// table starts empty and is a candidate only.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskAwsResourcesSchema, awsSeededKinds, type TaskAwsResource } from "@rovara-code/contracts";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { EmulatorSeedError, buildAwsSeedDocument, placeholderSecretValue, readAwsResourcesFromIac, seedReportCovers } from "../../packages/worker/src/service-seed-aws.js";

const placeholder = () => "placeholder-value";
// A value that looks like what a repository must never leak: built here at run time, so no key-shaped text sits in this file.
const REAL_LOOKING = ["hunter", "2-real-", "password"].join("");

describe("awsSeededKinds", () => {
  it("lists the services that have a seed handler, by key, and reads a legacy spelling as its key", () => {
    expect(awsSeededKinds("s3")).toEqual(["bucket"]);
    expect(awsSeededKinds("secretsmanager")).toEqual(["secret"]);
    expect(awsSeededKinds("events")).toEqual(["bus", "rule"]);
    expect(awsSeededKinds("kms")).toEqual(["key"]);
    for (const empty of ["kinesis", "sfn", "cognito-identity-provider", "ec2", "nosuchservice", "constructor"]) expect(awsSeededKinds(empty)).toEqual([]);
  });
});

describe("buildAwsSeedDocument: the new kinds", () => {
  const resources: TaskAwsResource[] = [
    { kind: "queue", name: "jobs" },
    { kind: "topic", name: "alerts", queues: ["jobs"] },
    { kind: "topic", name: "plain" },
    { kind: "secret", name: "app/db-password" },
    { kind: "parameter", name: "/app/region", value: "us-east-1" },
    { kind: "parameter", name: "/app/built" },
    { kind: "key", name: "MainKey", alias: "alias/main" },
    { kind: "key", name: "OtherKey" },
    { kind: "bus", name: "orders-bus" },
    { kind: "rule", name: "nightly", schedule: "rate(1 day)" },
    { kind: "rule", name: "on-order", bus: "orders-bus", pattern: '{"source":["orders"]}' },
  ];
  it("makes the front's sections: sns with queue ARNs, secretsmanager, ssm, kms, events", () => {
    const document = buildAwsSeedDocument("us-west-2", resources, placeholder);
    expect(document).toEqual({
      region: "us-west-2",
      sqs: { queues: [{ name: "jobs" }] },
      sns: { topics: [{ name: "alerts", subscriptions: [{ protocol: "sqs", endpoint: "arn:aws:sqs:us-west-2:000000000000:jobs" }] }, { name: "plain" }] },
      secretsmanager: { secrets: [{ name: "app/db-password", value: "placeholder-value" }] },
      ssm: { parameters: [{ name: "/app/region", value: "us-east-1", type: "String" }, { name: "/app/built", value: "placeholder-value", type: "String" }] },
      kms: { keys: [{ alias: "alias/main", description: "MainKey" }, { description: "OtherKey" }] },
      events: { buses: ["orders-bus"], rules: [{ name: "nightly", schedule: "rate(1 day)" }, { name: "on-order", bus: "orders-bus", pattern: '{"source":["orders"]}' }] },
    });
  });
  it("the placeholder of a secret is made here, fresh each time, plain letters and digits, and nothing the repository wrote", () => {
    const first = placeholderSecretValue();
    expect(first).toMatch(/^rovara-placeholder-[A-Za-z0-9]{12}$/u);
    expect(placeholderSecretValue()).not.toBe(first);
    const document = buildAwsSeedDocument("us-east-1", [{ kind: "secret", name: "a-secret" }, { kind: "parameter", name: "/p/q" }]);
    expect(document.secretsmanager!.secrets[0]!.value).toMatch(/^rovara-placeholder-/u);
    expect(document.ssm!.parameters[0]!.value).toMatch(/^rovara-placeholder-/u);
  });
  it("refuses a subscription to a queue the document does not create, a parameter of another type, and a rule with no pattern or schedule", () => {
    const refused = (list: unknown) => { try { buildAwsSeedDocument("us-east-1", list as TaskAwsResource[], placeholder); return undefined; } catch (error) { return error; } };
    expect(refused([{ kind: "topic", name: "alerts", queues: ["missing"] }])).toBeInstanceOf(EmulatorSeedError);
    expect(refused([{ kind: "parameter", name: "/p/q", type: "SecureString", value: "x" }])).toBeInstanceOf(EmulatorSeedError);
    expect(refused([{ kind: "parameter", name: "/p/q", type: "StringList" }])).toBeInstanceOf(EmulatorSeedError);
    expect(refused([{ kind: "rule", name: "r" }])).toBeInstanceOf(EmulatorSeedError);
    expect(refused([{ kind: "bus", name: "default" }])).toBeInstanceOf(EmulatorSeedError);
    expect(refused([{ kind: "key", name: "K", alias: "alias/aws/s3" }])).toBeInstanceOf(EmulatorSeedError);
    expect(refused([{ kind: "parameter", name: "/aws/reserved", value: "x" }])).toBeInstanceOf(EmulatorSeedError);
    expect(refused([{ kind: "secret", name: "s", extra: 1 }])).toBeInstanceOf(EmulatorSeedError);
    expect(refused([{ kind: "parameter", name: "/p/q", type: "String", value: REAL_LOOKING.padEnd(60, "x") + ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("") }])).toBeInstanceOf(EmulatorSeedError);
  });
  it("is unique by kind and name", () => {
    expect(TaskAwsResourcesSchema.safeParse([{ kind: "secret", name: "s" }, { kind: "secret", name: "s" }]).success).toBe(false);
    expect(TaskAwsResourcesSchema.safeParse([{ kind: "secret", name: "s" }, { kind: "parameter", name: "s" }]).success).toBe(true);
  });
});

describe("seedReportCovers: the front's step of each kind", () => {
  const resources: TaskAwsResource[] = [
    { kind: "topic", name: "alerts" }, { kind: "secret", name: "app/s" }, { kind: "parameter", name: "/p" }, { kind: "key", name: "K", alias: "alias/k" }, { kind: "key", name: "Plain" },
    { kind: "bus", name: "b" }, { kind: "rule", name: "r", schedule: "rate(1 day)" },
  ];
  const step = (service: string, action: string, name: string) => ({ service, action, name, ok: true });
  const good = [
    step("sns", "CreateTopic", "alerts"), step("secretsmanager", "CreateSecret", "app/s"), step("ssm", "PutParameter", "/p"), step("kms", "CreateKey", "alias/k"), step("kms", "CreateKey", "Plain"),
    step("events", "CreateEventBus", "b"), step("events", "PutRule", "r"),
  ];
  it("accepts exactly the steps of the resources (a key is named by its alias, or by its label when it has none)", () => {
    expect(seedReportCovers({ ok: true, failed: 0, steps: good }, resources)).toBe(true);
    expect(seedReportCovers({ ok: true, failed: 0, steps: good.slice(1) }, resources)).toBe(false);
    expect(seedReportCovers({ ok: true, failed: 0, steps: [...good.slice(0, 3), step("kms", "CreateKey", "K"), ...good.slice(4)] }, resources)).toBe(false);
    expect(seedReportCovers({ ok: true, failed: 0, steps: [...good.slice(0, 6), step("events", "CreateEventBus", "r")] }, resources)).toBe(false);
    expect(seedReportCovers({ ok: false, failed: 1, steps: good }, resources)).toBe(false);
  });
});

describe("what the detector reads from infrastructure code", () => {
  async function detect(files: Record<string, string>) {
    const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
    return runDetectors(bounded.reader, "svc");
  }
  const resourcesOf = (detection: Awaited<ReturnType<typeof detect>>, family: string) => detection.dependencies?.find((item) => item.family === family)?.hints.resources;

  const template = [
    "Resources:",
    "  Jobs:", "    Type: AWS::SQS::Queue", "    Properties: { QueueName: jobs }",
    "  Alerts:", "    Type: AWS::SNS::Topic", "    Properties:", "      TopicName: alerts", "      Subscription:", "        - Protocol: sqs", "          Endpoint: !GetAtt Jobs.Arn",
    "  Fanout:", "    Type: AWS::SNS::Subscription", "    Properties:", "      Protocol: sqs", "      TopicArn: !Ref Alerts", "      Endpoint: !GetAtt Jobs.Arn",
    "  DbPassword:", "    Type: AWS::SecretsManager::Secret", "    Properties:", "      Name: app/db-password", `      SecretString: ${REAL_LOOKING}`,
    "  Region:", "    Type: AWS::SSM::Parameter", "    Properties: { Name: /app/region, Type: String, Value: us-east-1 }",
    "  Secure:", "    Type: AWS::SSM::Parameter", "    Properties: { Name: /app/secure, Type: SecureString, Value: whatever }",
    "  Linked:", "    Type: AWS::SSM::Parameter", "    Properties: { Name: /app/bucket, Type: String, Value: !Ref Jobs }",
    "  Main:", "    Type: AWS::KMS::Key",
    "  MainAlias:", "    Type: AWS::KMS::Alias", "    Properties: { AliasName: alias/main, TargetKeyId: !Ref Main }",
    "  Bus:", "    Type: AWS::Events::EventBus", "    Properties: { Name: orders-bus }",
    "  Nightly:", "    Type: AWS::Events::Rule", "    Properties: { Name: nightly, ScheduleExpression: rate(1 day) }",
    "  OnOrder:", "    Type: AWS::Events::Rule", "    Properties:", "      Name: on-order", "      EventBusName: orders-bus", "      EventPattern:", "        source: [orders]",
    "  Empty:", "    Type: AWS::Events::Rule", "    Properties: { Name: empty }",
    "",
  ].join("\n");

  it("CloudFormation: topic with its queue, secret by name only, parameter literals only, key with its alias, bus and rules", async () => {
    const detection = await detect({ "template.yaml": template });
    expect(resourcesOf(detection, "aws:sns")).toEqual([{ kind: "topic", name: "alerts", queues: ["jobs"] }]);
    expect(resourcesOf(detection, "aws:secrets-manager")).toEqual([{ kind: "secret", name: "app/db-password" }]);
    expect(JSON.stringify(detection)).not.toContain(REAL_LOOKING);
    // A `!Ref` is a reference, not a value: the parameter is listed without one. A SecureString or StringList parameter is not a resource.
    expect(resourcesOf(detection, "aws:ssm")).toEqual([{ kind: "parameter", name: "/app/region", value: "us-east-1" }, { kind: "parameter", name: "/app/bucket" }]);
    expect(resourcesOf(detection, "aws:kms")).toEqual([{ kind: "key", name: "Main", alias: "alias/main" }]);
    expect(resourcesOf(detection, "aws:eventbridge")).toEqual([
      { kind: "bus", name: "orders-bus" }, { kind: "rule", name: "nightly", schedule: "rate(1 day)" }, { kind: "rule", name: "on-order", bus: "orders-bus", pattern: '{"source":["orders"]}' },
    ]);
    for (const family of ["aws:sns", "aws:secrets-manager", "aws:ssm", "aws:kms", "aws:eventbridge"]) expect(detection.dependencies!.find((item) => item.family === family)!.hints).not.toHaveProperty("startsEmpty");
  });
  it("JSON template: the same through the JSON reader", async () => {
    const json = JSON.stringify({ Resources: {
      Jobs: { Type: "AWS::SQS::Queue" },
      Alerts: { Type: "AWS::SNS::Topic", Properties: { Subscription: [{ Protocol: "sqs", Endpoint: { "Fn::GetAtt": ["Jobs", "Arn"] } }] } },
      Secret: { Type: "AWS::SecretsManager::Secret", Properties: { Name: "s1", SecretString: REAL_LOOKING } },
      Param: { Type: "AWS::SSM::Parameter", Properties: { Name: "/a/b", Type: "String", Value: "plain" } },
    } }, null, 2);
    const detection = await detect({ "cdk.out/Stack.template.json": json });
    expect(resourcesOf(detection, "aws:sns")).toEqual([{ kind: "topic", name: "Alerts", queues: ["Jobs"] }]);
    expect(resourcesOf(detection, "aws:ssm")).toEqual([{ kind: "parameter", name: "/a/b", value: "plain" }]);
    expect(JSON.stringify(detection)).not.toContain(REAL_LOOKING);
  });

  const terraform = [
    'resource "aws_sqs_queue" "jobs" {', '  name = "jobs"', "}",
    'resource "aws_sns_topic" "alerts" {', '  name = "alerts"', "}",
    'resource "aws_sns_topic_subscription" "fan" {', "  topic_arn = aws_sns_topic.alerts.arn", '  protocol  = "sqs"', "  endpoint  = aws_sqs_queue.jobs.arn", "}",
    'resource "aws_secretsmanager_secret" "db" {', '  name = "app/db"', "}",
    'resource "aws_secretsmanager_secret_version" "db" {', "  secret_id = aws_secretsmanager_secret.db.id", `  secret_string = "${REAL_LOOKING}"`, "}",
    'resource "aws_ssm_parameter" "region" {', '  name  = "/app/region"', '  type  = "String"', '  value = "us-east-1"', "}",
    'resource "aws_ssm_parameter" "secure" {', '  name  = "/app/secure"', '  type  = "SecureString"', `  value = "${REAL_LOOKING}"`, "}",
    'resource "aws_kms_key" "main" {', '  description = "main"', "}",
    'resource "aws_kms_alias" "main" {', '  name = "alias/main"', "  target_key_id = aws_kms_key.main.key_id", "}",
    'resource "aws_cloudwatch_event_bus" "orders" {', '  name = "orders-bus"', "}",
    'resource "aws_cloudwatch_event_rule" "nightly" {', '  name = "nightly"', '  schedule_expression = "rate(1 day)"', "  event_bus_name = aws_cloudwatch_event_bus.orders.name", "}",
    'resource "aws_cloudwatch_event_rule" "on_order" {', '  name = "on-order"', "  event_pattern = <<EOF", '{"source": ["orders"]}', "EOF", "}",
    "",
  ].join("\n");
  it("Terraform: the same kinds, subscriptions and aliases by reference; a secret version is never read and a SecureString parameter is not seeded", async () => {
    const detection = await detect({ "main.tf": terraform });
    expect(resourcesOf(detection, "aws:sns")).toEqual([{ kind: "topic", name: "alerts", queues: ["jobs"] }]);
    expect(resourcesOf(detection, "aws:secrets-manager")).toEqual([{ kind: "secret", name: "app/db" }]);
    expect(resourcesOf(detection, "aws:ssm")).toEqual([{ kind: "parameter", name: "/app/region", value: "us-east-1" }]);
    expect(resourcesOf(detection, "aws:kms")).toEqual([{ kind: "key", name: "main", alias: "alias/main" }]);
    expect(resourcesOf(detection, "aws:eventbridge")).toEqual([
      { kind: "bus", name: "orders-bus" }, { kind: "rule", name: "nightly", schedule: "rate(1 day)", bus: "orders-bus" }, { kind: "rule", name: "on-order", pattern: '{"source":["orders"]}' },
    ]);
    expect(JSON.stringify(detection)).not.toContain(REAL_LOOKING);
  });

  const cdkTs = [
    'import * as sqs from "aws-cdk-lib/aws-sqs";', 'import * as sns from "aws-cdk-lib/aws-sns";', 'import * as subs from "aws-cdk-lib/aws-sns-subscriptions";', 'import * as kms from "aws-cdk-lib/aws-kms";',
    'import * as ssm from "aws-cdk-lib/aws-ssm";', 'import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";', 'import * as events from "aws-cdk-lib/aws-events";',
    "export class S extends Stack {", "  constructor(scope: Construct) {",
    '    const jobs = new sqs.Queue(this, "Jobs", { queueName: "jobs" });',
    '    const alerts = new sns.Topic(this, "Alerts", { topicName: "alerts" });',
    "    alerts.addSubscription(new subs.SqsSubscription(jobs));",
    '    new secretsmanager.Secret(this, "Db", { secretName: "app/db" });',
    `    new ssm.StringParameter(this, "Region", { parameterName: "/app/region", stringValue: "us-east-1" });`,
    '    new kms.Key(this, "Main", { alias: "alias/main" });',
    '    new events.EventBus(this, "Orders", { eventBusName: "orders-bus" });',
    "  }", "}", "",
  ].join("\n");
  it("CDK TypeScript: constructs by class, an SQS subscription by variable, and the module of a common word only when it is imported", async () => {
    const detection = await detect({ "lib/stack.ts": cdkTs });
    expect(resourcesOf(detection, "aws:sns")).toEqual([{ kind: "topic", name: "alerts", queues: ["jobs"] }]);
    expect(resourcesOf(detection, "aws:secrets-manager")).toEqual([{ kind: "secret", name: "app/db" }]);
    expect(resourcesOf(detection, "aws:ssm")).toEqual([{ kind: "parameter", name: "/app/region", value: "us-east-1" }]);
    expect(resourcesOf(detection, "aws:kms")).toEqual([{ kind: "key", name: "Main", alias: "alias/main" }]);
    expect(resourcesOf(detection, "aws:eventbridge")).toEqual([{ kind: "bus", name: "orders-bus" }]);
    // A `Key` or `Secret` of a file that does not import the module is something else.
    const other = await detect({ "lib/other.ts": 'import { Stack } from "aws-cdk-lib";\nnew Key(this, "K", { alias: "alias/x" });\nnew Secret(this, "S", { secretName: "x1" });\n' });
    expect(resourcesOf(other, "aws:kms")).toBeUndefined();
    expect(resourcesOf(other, "aws:secrets-manager")).toBeUndefined();
  });
  it("CDK Python: the same by keyword arguments", async () => {
    const py = [
      "from aws_cdk import aws_sqs as sqs, aws_sns as sns, aws_sns_subscriptions as subs, aws_secretsmanager as secretsmanager, aws_kms as kms",
      "class S(Stack):", "    def __init__(self, scope):",
      '        jobs = sqs.Queue(self, "Jobs", queue_name="jobs")',
      '        alerts = sns.Topic(self, "Alerts", topic_name="alerts")',
      "        alerts.add_subscription(subs.SqsSubscription(jobs))",
      '        secretsmanager.Secret(self, "Db", secret_name="app/db")',
      '        kms.Key(self, "Main", alias="alias/main")',
      "",
    ].join("\n");
    const detection = await detect({ "infra/app_stack.py": py });
    expect(resourcesOf(detection, "aws:sns")).toEqual([{ kind: "topic", name: "alerts", queues: ["jobs"] }]);
    expect(resourcesOf(detection, "aws:secrets-manager")).toEqual([{ kind: "secret", name: "app/db" }]);
    expect(resourcesOf(detection, "aws:kms")).toEqual([{ kind: "key", name: "Main", alias: "alias/main" }]);
  });
});

describe("readAwsResourcesFromIac for a wide plan", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "seed-wide-")); await mkdir(join(root, "svc"), { recursive: true }); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const template = [
    "Resources:",
    "  Jobs:", "    Type: AWS::SQS::Queue", "    Properties: { QueueName: jobs }",
    "  Alerts:", "    Type: AWS::SNS::Topic", "    Properties:", "      TopicName: alerts", "      Subscription:", "        - Protocol: sqs", "          Endpoint: !GetAtt Jobs.Arn",
    "  Db:", "    Type: AWS::SecretsManager::Secret", "    Properties: { Name: app/db }",
    "  Stream:", "    Type: AWS::Kinesis::Stream",
    "",
  ].join("\n");
  const read = async (services: string[]) => {
    await writeFile(join(root, "svc", "template.yaml"), template);
    return readAwsResourcesFromIac({ ref: { path: "svc/template.yaml" }, services, rootPath: root, repositoryPaths: [join(root, "svc")] });
  };

  it("reads the kinds of the services the plan names, and nothing of a service that starts empty (kinesis here)", async () => {
    const resources = await read(["sns", "sqs", "secretsmanager", "kinesis"]);
    expect(resources).toEqual([
      { kind: "queue", name: "jobs" }, { kind: "topic", name: "alerts", queues: ["jobs"] }, { kind: "secret", name: "app/db" },
    ]);
    expect(buildAwsSeedDocument("us-east-1", resources, placeholder).sns!.topics[0]!.subscriptions).toHaveLength(1);
  });
  it("a topic of a plan without SQS has no subscription (the queue is not created), and a plan whose services have nothing in the file is refused", async () => {
    expect(await read(["sns"])).toEqual([{ kind: "topic", name: "alerts" }]);
    await expect(read(["kinesis"])).rejects.toBeInstanceOf(EmulatorSeedError);
  });
});
