// Test services TS11 (D7): IaC resources, with the DynamoDB key schema, from CloudFormation, SAM, Terraform and CDK.
import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

describe("CloudFormation and SAM", () => {
  const template = [
    "AWSTemplateFormatVersion: '2010-09-09'",
    "Transform: AWS::Serverless-2016-10-31",
    "Resources:",
    "  Orders:",
    "    Type: AWS::DynamoDB::Table",
    "    Properties:",
    "      TableName: orders-table",
    "      AttributeDefinitions:",
    "        - AttributeName: pk",
    "          AttributeType: S",
    "        - AttributeName: created",
    "          AttributeType: N",
    "      KeySchema:",
    "        - AttributeName: pk",
    "          KeyType: HASH",
    "        - AttributeName: created",
    "          KeyType: RANGE",
    "  Sessions:",
    "    Type: AWS::Serverless::SimpleTable",
    "    Properties:",
    "      PrimaryKey: { Name: sid, Type: String }",
    "  Files:",
    "    Type: AWS::S3::Bucket",
    "    Properties:",
    "      BucketName: !Sub 'files-${Stage}'",
    "  Jobs:",
    "    Type: AWS::SQS::Queue",
    "    Properties: { QueueName: jobs }",
    "  Alerts:",
    "    Type: AWS::SNS::Topic",
    "  Fn:",
    "    Type: AWS::Serverless::Function",
    "",
  ].join("\n");

  it("reads a JSON template, including a committed cdk.out one", async () => {
    const json = JSON.stringify({ Resources: { T: { Type: "AWS::DynamoDB::Table", Properties: { KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "id", AttributeType: "B" }] } } } }, null, 2);
    const detection = await detect({ "cdk.out/Stack.template.json": json });
    expect(family(detection, "aws:dynamodb")!.hints.resources).toEqual([{ kind: "table", name: "T", keySchema: { partitionKey: { name: "id", type: "B" } } }]);
    expect(family(detection, "aws:dynamodb")!.evidence).toEqual([{ path: "cdk.out/Stack.template.json", line: 3 }]);
  });
  it("skips a hostile template with a fixed-words note and reads the others", async () => {
    const bomb = ["Resources: &r", "  A: &a [x,x,x,x,x,x,x,x,x]", ...Array.from({ length: 9 }, (_, i) => `  B${String(i)}: &b${String(i)} [${Array.from({ length: 9 }, () => (i === 0 ? "*a" : `*b${String(i - 1)}`)).join(",")}]`), "# AWS::DynamoDB::Table", ""].join("\n");
    const detection = await detect({ "templates/bomb.yaml": bomb, "template.yaml": template });
    expect(family(detection, "aws:s3")).toBeDefined();
    expect(detection.notes.join(" ")).toContain("so it was not read");
  });
});

describe("Terraform", () => {
  it("reads tables with hash and range keys and attribute types, buckets, queues and topics", async () => {
    const tf = [
      'resource "aws_dynamodb_table" "orders" {',
      '  name         = "orders"',
      '  hash_key     = "pk"',
      '  range_key    = "sk"',
      "  attribute {",
      '    name = "pk"',
      '    type = "S"',
      "  }",
      "  attribute {",
      '    name = "sk"',
      '    type = "N"',
      "  }",
      "}",
      'resource "aws_s3_bucket" "files" {',
      "  bucket = var.bucket_name",
      "}",
      'resource "aws_sqs_queue" "jobs" { name = "jobs-queue" }',
      'resource "aws_sns_topic" "alerts" {',
      '  name = "alerts"',
      "}",
      "",
    ].join("\n");
    const detection = await detect({ "infra/main.tf": tf });
    expect(family(detection, "aws:dynamodb")).toMatchObject({ evidence: [{ path: "infra/main.tf", line: 1 }], hints: { resources: [{ kind: "table", name: "orders", keySchema: { partitionKey: { name: "pk", type: "S" }, sortKey: { name: "sk", type: "N" } } }] } });
    expect(family(detection, "aws:s3")!.hints.resources).toEqual([{ kind: "bucket", name: "files" }]);
    expect(family(detection, "aws:sqs")!.hints.resources).toEqual([{ kind: "queue", name: "jobs-queue" }]);
    expect(family(detection, "aws:sns")!.hints.resources).toEqual([{ kind: "topic", name: "alerts" }]);
  });
});

describe("AWS CDK source", () => {
  it("TypeScript: tables with partition and sort keys, buckets, queues and topics", async () => {
    const ts = [
      'import * as dynamodb from "aws-cdk-lib/aws-dynamodb";',
      'import { Bucket } from "aws-cdk-lib/aws-s3";',
      "export class S extends Stack {",
      "  constructor(scope: Construct) {",
      '    new dynamodb.Table(this, "OrdersTable", {',
      '      tableName: "orders",',
      '      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },',
      '      sortKey: { name: "ts", type: dynamodb.AttributeType.NUMBER },',
      "    });",
      '    new Bucket(this, "Files", { bucketName: `files-${stage}` });',
      '    new sqs.Queue(this, "Jobs");',
      '    new sns.Topic(this, "Alerts", { topicName: "alerts" });',
      "  }",
      "}",
      "",
    ].join("\n");
    const detection = await detect({ "lib/stack.ts": ts });
    expect(family(detection, "aws:dynamodb")!.hints.resources).toEqual([{ kind: "table", name: "orders", keySchema: { partitionKey: { name: "pk", type: "S" }, sortKey: { name: "ts", type: "N" } } }]);
    // The import of the CDK module is a sighting too (line 1), then the construct (line 5).
    expect(family(detection, "aws:dynamodb")!.evidence).toEqual([{ path: "lib/stack.ts", line: 1 }, { path: "lib/stack.ts", line: 5 }]);
    expect(family(detection, "aws:s3")!.hints.resources).toEqual([{ kind: "bucket", name: "Files" }]);
    expect(family(detection, "aws:sqs")!.hints.resources).toEqual([{ kind: "queue", name: "Jobs" }]);
    expect(family(detection, "aws:sns")!.hints.resources).toEqual([{ kind: "topic", name: "alerts" }]);
  });
  it("Python: keyword arguments", async () => {
    const py = ["from aws_cdk import aws_dynamodb as dynamodb", "class S(Stack):", "    def __init__(self, scope):", '        dynamodb.Table(self, "T", partition_key=dynamodb.Attribute(name="id", type=dynamodb.AttributeType.STRING), sort_key=dynamodb.Attribute(name="v", type=dynamodb.AttributeType.NUMBER), table_name="things")', ""].join("\n");
    const detection = await detect({ "infra/app_stack.py": py });
    expect(family(detection, "aws:dynamodb")!.hints.resources).toEqual([{ kind: "table", name: "things", keySchema: { partitionKey: { name: "id", type: "S" }, sortKey: { name: "v", type: "N" } } }]);
  });
});

describe("limits", () => {
  it("keeps at most 24 resources of one family and says so", async () => {
    const template = ["Resources:", ...Array.from({ length: 30 }, (_, index) => `  Q${String(index)}:\n    Type: AWS::SQS::Queue`), ""].join("\n");
    const detection = await detect({ "template.yaml": template });
    expect(family(detection, "aws:sqs")!.hints.resources).toHaveLength(24);
    expect(detection.notes.join(" ")).toContain("More than 24 resources");
  });
});
