// Test services TS10 (D4, D5): driver and SDK rules across Python, Node, Java/Kotlin and Go, in manifests and in code, and the explicit-endpoint flag.
import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);
const families = (detection: Awaited<ReturnType<typeof detect>>) => (detection.dependencies ?? []).map((item) => item.family).sort();

describe("Python", () => {
  it("lists drivers from requirements, pyproject dependency tables and arrays, and boto3 stubs", async () => {
    const detection = await detect({
      "requirements.txt": "# redis is described here\npsycopg2-binary==2.9\n-r base.txt\nPyMongo>=4\nboto3-stubs[s3,dynamodb]==1.35\nrequests\n",
      "pyproject.toml": ['[project]', 'description = "talks to kafka and mysql"', 'keywords = ["pika"]', 'dependencies = [', '  "redis>=5",', '  "kafka-python",', ']', '[project.optional-dependencies]', 'test = ["pymysql", "elasticsearch[async]"]', '[tool.pytest.ini_options]', 'addopts = "-q"', ''].join("\n"),
    });
    expect(families(detection)).toEqual(["aws:dynamodb", "aws:s3", "elasticsearch", "kafka", "mongodb", "mysql", "postgres", "redis"]);
    expect(family(detection, "postgres")).toMatchObject({ strength: "mentioned", evidence: [{ path: "requirements.txt", line: 2 }], hints: { seenBy: ["driver"] } });
    expect(family(detection, "redis")!.evidence).toEqual([{ path: "pyproject.toml", line: 5 }]);
    expect(family(detection, "kafka")!.evidence).toEqual([{ path: "pyproject.toml", line: 6 }]);
  });
});

describe("Node", () => {
  it("leaves SageMaker Runtime to the SageMaker detector in every language: the SDK and driver rules report none of it", async () => {
    const detection = await detect({
      "package.json": JSON.stringify({ dependencies: { "@aws-sdk/client-sagemaker-runtime": "3" } }),
      "src/a.ts": 'import { SageMakerRuntimeClient } from "@aws-sdk/client-sagemaker-runtime";\n',
      "go.mod": "module x\n\nrequire github.com/aws/aws-sdk-go-v2/service/sagemakerruntime v1.0.0\n",
      "A.java": "import software.amazon.awssdk.services.sagemakerruntime.SageMakerRuntimeClient;\n",
    });
    expect(detection.dependencies?.map((item) => [item.family, item.hints.seenBy])).toEqual([["aws:sagemaker-runtime", ["sagemaker"]]]);
    expect(detection.dependencies![0]!.evidence.map((item) => item.path)).toEqual(["src/a.ts"]);
  });
  it("lists drivers and AWS SDK packages from package.json, including workspace packages", async () => {
    const detection = await detect({
      "package.json": JSON.stringify({ dependencies: { pg: "^8", "@aws-sdk/client-s3": "3", "@aws-sdk/lib-dynamodb": "3", "@aws-sdk/client-sagemaker-runtime": "3", express: "4" }, devDependencies: { ioredis: "5", kafkajs: "2" } }, null, 2),
      "packages/api/package.json": JSON.stringify({ dependencies: { amqplib: "0.10", "@aws-sdk/s3-request-presigner": "3", mongoose: "8" } }),
    });
    expect(families(detection)).toEqual(["aws:dynamodb", "aws:s3", "kafka", "mongodb", "postgres", "rabbitmq", "redis"]);
    expect(family(detection, "aws:s3")).toMatchObject({ strength: "mentioned", evidence: [{ path: "package.json", line: 4 }, { path: "packages/api/package.json", line: 1 }] });
  });
  it("finds SDK v3 clients and v2 services, flagging a literal endpoint", async () => {
    const code = ['import { S3Client } from "@aws-sdk/client-s3";', 'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";', 'import AWS from "aws-sdk";', 'const s3 = new S3Client({ region: "us-east-1", endpoint: "http://localhost:4566" });', "const ddb = new DynamoDBClient({ endpoint: process.env.AWS_ENDPOINT_URL });", 'const sqs = new AWS.SQS({ endpoint: "http://localhost:4566" });', ""].join("\n");
    const detection = await detect({ "src/aws.ts": code });
    expect(family(detection, "aws:s3")).toMatchObject({ evidence: [{ path: "src/aws.ts", line: 1 }], hints: { explicitEndpoint: true } });
    expect(family(detection, "aws:dynamodb")!.hints.explicitEndpoint).toBeUndefined();
    expect(family(detection, "aws:sqs")!.hints.explicitEndpoint).toBe(true);
  });
  it("finds drivers by import and flags a connection URL written in the call", async () => {
    const code = ['import { Pool } from "pg";', 'import { createClient } from "redis";', 'const amqp = require("amqplib");', 'const { Kafka } = require("kafkajs");', 'const pool = new Pool({ connectionString: "postgres://localhost/app" });', "const client = createClient({ url: process.env.REDIS_URL });", 'amqp.connect("amqp://rabbit");', "new Kafka({ brokers: [process.env.BROKER] });", ""].join("\n");
    const detection = await detect({ "src/db.js": code });
    expect(family(detection, "postgres")!.hints.explicitEndpoint).toBe(true);
    expect(family(detection, "redis")!.hints.explicitEndpoint).toBeUndefined();
    expect(family(detection, "rabbitmq")!.hints.explicitEndpoint).toBe(true);
    expect(family(detection, "kafka")!.hints.explicitEndpoint).toBeUndefined();
  });
});

describe("Java and Kotlin", () => {
  it("lists drivers and AWS modules from Maven and Gradle files, skipping non-service artifacts", async () => {
    const pom = ["<project>", "  <dependencies>", "    <dependency>", "      <groupId>org.postgresql</groupId>", "      <artifactId>postgresql</artifactId>", "    </dependency>", "    <dependency>", "      <groupId>software.amazon.awssdk</groupId>", "      <artifactId>dynamodb-enhanced</artifactId>", "    </dependency>", "    <dependency>", "      <groupId>software.amazon.awssdk</groupId>", "      <artifactId>sdk-core</artifactId>", "    </dependency>", "    <dependency>", "      <groupId>org.springframework.kafka</groupId>", "      <artifactId>spring-kafka</artifactId>", "    </dependency>", "  </dependencies>", "</project>", ""].join("\n");
    const gradle = ['dependencies {', '  implementation("redis.clients:jedis:5.0.0")', "  testImplementation 'com.amazonaws:aws-java-sdk-sqs:1.12.0'", "  implementation 'com.amazonaws:aws-java-sdk-core:1.12.0'", '  implementation("com.rabbitmq:amqp-client:5.20.0")', "}", ""].join("\n");
    const detection = await detect({ "pom.xml": pom, "svc/build.gradle": gradle });
    expect(families(detection)).toEqual(["aws:dynamodb", "aws:sqs", "kafka", "postgres", "rabbitmq", "redis"]);
    expect(family(detection, "postgres")!.evidence).toEqual([{ path: "pom.xml", line: 3 }]);
    expect(family(detection, "redis")!.evidence).toEqual([{ path: "svc/build.gradle", line: 2 }]);
  });
  it("finds AWS SDK v2 builders and flags endpointOverride with a literal URI", async () => {
    const code = ["import software.amazon.awssdk.services.s3.S3Client;", "import software.amazon.awssdk.services.dynamodb.DynamoDbClient;", "class A {", '  S3Client s3 = S3Client.builder().region(r).endpointOverride(URI.create("http://localhost:4566")).build();', "  DynamoDbClient d = DynamoDbClient.builder().endpointOverride(URI.create(System.getenv(\"E\"))).build();", "}", ""].join("\n");
    const detection = await detect({ "src/main/java/A.java": code });
    expect(family(detection, "aws:s3")!.hints.explicitEndpoint).toBe(true);
    expect(family(detection, "aws:dynamodb")!.hints.explicitEndpoint).toBeUndefined();
  });
});

describe("Go", () => {
  it("lists drivers and AWS service modules from go.mod", async () => {
    const mod = ["module example.com/svc", "", "go 1.22", "", "require (", "\tgithub.com/lib/pq v1.10.9", "\tgithub.com/redis/go-redis/v9 v9.5.1", "\tgithub.com/aws/aws-sdk-go-v2/service/s3 v1.50.0", "\tgithub.com/aws/aws-sdk-go-v2/service/sagemakerruntime v1.0.0", "\tgithub.com/aws/aws-sdk-go-v2 v1.25.0", ")", ""].join("\n");
    const detection = await detect({ "go.mod": mod });
    expect(families(detection)).toEqual(["aws:s3", "postgres", "redis"]);
    expect(family(detection, "postgres")!.evidence).toEqual([{ path: "go.mod", line: 6 }]);
  });
});

