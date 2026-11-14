// Test services TS11 (D6): in-process fakes give faked_by_tests; Testcontainers give a dependency plus the note that Rovara starts the service itself.
import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

describe("in-process fakes", () => {
  it("Python: moto decorators, the boto3 clients under mock_aws, stubbed clients, patched drivers and fake servers", async () => {
    const test = ["import boto3", "from moto import mock_aws, mock_s3", "import fakeredis", "from unittest.mock import patch", "", "@mock_s3", "def test_a():", '    boto3.client("s3")', "", "@mock_aws", "def test_b():", '    boto3.client("sqs")', '    boto3.resource("dynamodb")', "", 'def test_c():', '    with patch("app.cache.redis.Redis"):', "        pass", '    with patch("app.db.psycopg2.connect"):', "        pass", "    mock_open = 1", ""].join("\n");
    const detection = await detect({ "tests/test_aws.py": test });
    for (const id of ["aws:s3", "aws:sqs", "aws:dynamodb", "redis", "postgres"]) expect(family(detection, id), id).toMatchObject({ strength: "used", hints: { fakedByTests: true, seenBy: ["test"] } });
    expect(family(detection, "aws:s3")!.evidence[0]).toEqual({ path: "tests/test_aws.py", line: 2 });
    expect(family(detection, "aws:open")).toBeUndefined();
    expect(detection.notes.join(" ")).toContain("fake a dependency inside their own process");
  });
  it("Python: botocore Stubber and HTTP interceptors", async () => {
    const test = ["import boto3", "from botocore.stub import Stubber", "import responses", 'client = boto3.client("kms")', "stub = Stubber(client)", '@responses.activate', 'def test_x():', '    responses.add(responses.GET, "https://api.partner.example.net/v1/x?token=abc", json={})', '    responses.add(responses.GET, "http://localhost:8000/x")', ""].join("\n");
    const detection = await detect({ "tests/test_stub.py": test });
    expect(family(detection, "aws:kms")!.hints.fakedByTests).toBe(true);
    expect(family(detection, "http:api.partner.example.net")).toMatchObject({ kind: "http_api", hints: { fakedByTests: true } });
    expect(JSON.stringify(detection)).not.toContain("token=abc");
    expect(detection.dependencies!.map((item) => item.family)).not.toContain("http:localhost");
  });
  it("Node: aws-sdk-client-mock, module mocks, in-memory servers and nock", async () => {
    const test = ['import { mockClient } from "aws-sdk-client-mock";', 'import { S3Client } from "@aws-sdk/client-s3";', 'import nock from "nock";', 'jest.mock("ioredis");', 'vi.mock("@aws-sdk/client-sqs");', 'vi.mock("./local-file");', "const s3 = mockClient(S3Client);", 'nock("https://api.partner.example.net").get("/x").reply(200);', ""].join("\n");
    const detection = await detect({ "src/__tests__/a.test.ts": test });
    expect(["aws:s3", "aws:sqs", "redis", "http:api.partner.example.net"].every((id) => family(detection, id)?.hints.fakedByTests === true)).toBe(true);
  });
  it("Java and Go: mocked SDK clients, embedded servers and fake Redis", async () => {
    const java = ["import software.amazon.awssdk.services.s3.S3Client;", "@EmbeddedKafka", "class AT {", "  S3Client s3 = Mockito.mock(S3Client.class);", "}", ""].join("\n");
    const go = ['package x', 'import "github.com/alicebob/miniredis/v2"', ""].join("\n");
    const detection = await detect({ "src/test/java/AT.java": java, "svc_test.go": go });
    for (const id of ["aws:s3", "kafka", "redis"]) expect(family(detection, id)?.hints.fakedByTests, id).toBe(true);
  });
  it("only reads test files", async () => {
    const detection = await detect({ "app/main.py": 'from moto import mock_s3\n@mock_s3\ndef f(): pass\nimport fakeredis\n', "src/index.js": 'jest.mock("ioredis")' });
    expect(detection.dependencies?.some((item) => item.hints.fakedByTests === true)).toBeFalsy();
  });
});

describe("Testcontainers", () => {
  it("Python: module containers and generic containers with an image literal", async () => {
    const test = ["from testcontainers.postgres import PostgresContainer", "from testcontainers.core.container import DockerContainer", "", "def test_db():", '    with PostgresContainer("postgres:16") as pg:', "        pass", '    with DockerContainer("redis:7-alpine"):', "        pass", ""].join("\n");
    const detection = await detect({ "tests/conftest.py": test });
    expect(family(detection, "postgres")).toMatchObject({ strength: "used", evidence: [{ path: "tests/conftest.py", line: 1 }], hints: { testcontainers: true, version: "16" } });
    expect(family(detection, "redis")).toMatchObject({ hints: { testcontainers: true, version: "7" } });
    expect(family(detection, "postgres")!.hints.fakedByTests).toBeUndefined();
    expect(detection.notes.join(" ")).toContain("Testcontainers, which cannot run inside Rovara. Rovara starts the same service itself");
  });
  it("Java: typed containers, GenericContainer with DockerImageName and LocalStack services", async () => {
    const test = ["import org.testcontainers.containers.PostgreSQLContainer;", "class IT {", '  PostgreSQLContainer<?> db = new PostgreSQLContainer<>("postgres:15.2");', '  GenericContainer<?> r = new GenericContainer<>(DockerImageName.parse("redis:7"));', "  LocalStackContainer aws = new LocalStackContainer(img).withServices(LocalStackContainer.Service.S3, Service.SQS);", "}", ""].join("\n");
    const detection = await detect({ "src/test/java/IT.java": test });
    expect(family(detection, "postgres")!.hints).toMatchObject({ testcontainers: true, version: "15" });
    expect(family(detection, "redis")!.hints).toMatchObject({ testcontainers: true, version: "7" });
    expect(family(detection, "aws:s3")!.hints.testcontainers).toBe(true);
    expect(family(detection, "aws:sqs")!.hints.testcontainers).toBe(true);
  });
  it("Node and Go: module packages and image requests", async () => {
    const node = ['import { PostgreSqlContainer } from "@testcontainers/postgresql";', 'import { GenericContainer } from "testcontainers";', 'await new GenericContainer("mongo:7").start();', ""].join("\n");
    const go = ['package x', 'import "github.com/testcontainers/testcontainers-go/modules/redis"', 'req := testcontainers.ContainerRequest{Image: "rabbitmq:3.12"}', ""].join("\n");
    const detection = await detect({ "test/db.test.ts": node, "pkg/x_test.go": go });
    for (const id of ["postgres", "mongodb", "redis", "rabbitmq"]) expect(family(detection, id)?.hints.testcontainers, id).toBe(true);
    expect(family(detection, "mongodb")!.hints.version).toBe("7");
  });
  it("a repository without tests gives no dependencies and no new keys", async () => {
    expect(Object.hasOwn(await detect({ "README.md": "x" }), "dependencies")).toBe(false);
  });
});
