// Test services dependency detectors: hostile-input hardening (timing, userinfo, odd names, read budget, IaC names, YAML node cap, path list).
import { describe, expect, it } from "vitest";
import { ENV_DETECT_MAX_FILE_BYTES, ENV_DETECT_MAX_TOTAL_BYTES, boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { detectCompose } from "../../packages/worker/src/env-detect/compose.js";
import { safeEnvName } from "../../packages/worker/src/env-detect/dependency-candidates.js";
import { parseSafeYaml, YAML_LIMITS } from "../../packages/worker/src/env-detect/safe-yaml.js";
import type { RepositoryReader } from "../../packages/worker/src/env-detect/types.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);
// ENV_DETECT_FUZZ_SIZE is only for hunting slow patterns with a smaller input; the committed test uses the largest size the reader allows.
const SIZE = Number(process.env["ENV_DETECT_FUZZ_SIZE"] ?? ENV_DETECT_MAX_FILE_BYTES - 1);
const fill = (unit: string): string => unit.repeat(Math.floor(SIZE / unit.length)).slice(0, SIZE);

// One file of every kind a dependency detector reads, and bodies that make a backtracking pattern work hard: a run of newlines, of spaces, of one repeated token, of an unterminated opener.
const FILES = [
  "app.py", "tests/test_a.py", "tests/conftest.py", "A.java", "src/test/java/AT.java", "B.kt", "main.go", "pkg/x_test.go", "src/a.ts", "src/a.test.ts", "src/a.js",
  "requirements.txt", "pyproject.toml", "Pipfile", "setup.cfg", "tox.ini", "pytest.ini", "package.json", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "go.mod", "go.work", "Config",
  "application.properties", "application.yml", "application-test.yml", "appsettings.json", "config/a.yaml", "app/settings.py", ".env", ".env.example",
  "docker-compose.yml", ".devcontainer/devcontainer.json", ".github/workflows/ci.yml", ".gitlab-ci.yml", ".circleci/config.yml",
  "template.yaml", "cdk.out/a.template.json", "main.tf", "lib/stack.ts", "infra/app_stack.py", "README.md", "docs/runbook.md", ".kiro/steering/a.md", "cdk.json", "mvnw",
];
const BODIES: Record<string, string> = {
  newlines: fill("\n"), "space-newline": fill(" \n"), "tab-newline": fill("\t\n"), spaces: fill(" "), dots: fill("."), "word-dot": fill("a."), "word-slash": fill("aa/"), word: fill("a"),
  quote: fill("\""), "single-quote": fill("'"), bracket: fill("["), "word-bracket": fill("a["), brace: fill("{"), paren: fill("("), dash: fill("-"),
  // Many openers and no closer: a `opener[\s\S]*?closer` pattern rescans to the end from every one of them.
  "open-comment": fill("<!--"), "open-plugin": fill("<plugin>"), "open-profiles": fill("<profiles>"), "open-modules": fill("<modules>"), "open-dependency": fill("<dependency>"), "open-execution": fill("<execution>"), "open-block-comment": fill("/*"),
  "open-with-services": fill("withServices("), "open-register": fill("register<"), "open-include": fill("include "), "open-id": fill("id "), "open-source-compat": fill("sourceCompatibility "), "open-container": (fill("PostgreSQLContainer<") + "(").slice(-SIZE),
  import: fill("import "), "import-newline": fill("import\n"), assign: fill("x=\""), "key-colon": fill("a:\n  "), "require-line": fill("require \n"), "aws-types": fill("AWS::"), "host-eq": fill("host="),
};
// Whitespace-only files are what a backtracking `^\s*` pattern chokes on (the old failures took 26 s to minutes): those must finish in a second. The YAML library parses the other bodies in linear time, but with a big
// constant (about 1 s for 256 KiB of quotes on a busy machine), so they get a wider bound that a quadratic pattern would still miss by a wide margin.
const STRICT = new Set(["newlines", "space-newline", "tab-newline", "spaces"]);
const SCALE = SIZE / (ENV_DETECT_MAX_FILE_BYTES - 1);
const limitFor = (label: string): number => Math.max(150, (STRICT.has(label) || label.startsWith("kw:") || label.startsWith("open-") ? 1_000 : 5_000) * SCALE);

// A keyword a detector looks for, then a long run of spaces or newlines, then one more character: the shape that makes `keyword\s*optional\s*...` patterns backtrack.
const KEYWORDS = [
  "id", "sourceCompatibility", "targetCompatibility", "include", "register", "create", "plugins", "dependencies", "implementation", "require", "import", "from", "use", "services", "image",
  "apply plugin:", "task", "integrationTest", "jacocoTestReport", "JavaLanguageVersion.of(", "JavaVersion.VERSION_", "testImplementation", "api", "kotlin", "java", "id(", "id '", "version", "apply",
  "S3Client", "DynamoDBClient", "DynamoDbClient", "SQSClient", "SNSClient", "KinesisClient", "S3Client.builder()", "new AWS.S3(", "boto3.client(", "boto3.client(\"s3\"", "boto3.resource(", "aws-sdk", "@aws-sdk/client-s3",
  "endpoint_url=", "endpointOverride(", "BaseEndpoint", "mock_s3", "mock_aws", "patch(", "jest.mock(", "vi.mock(", "nock(", "mockClient(", "Stubber(", "responses.add(", "testcontainers", "PostgreSQLContainer",
  "GenericContainer", "DockerImageName.parse(", "LocalStackContainer", "withServices(", "Service.", "TestContainer", "@EmbeddedKafka",
  "plugins {\n  id", "plugins { id(", "plugins {\n  id '", "apply plugin: 'java'\nid", "dependencies {\n  implementation", "tasks.register", "tasks.register<Test>", "tasks.create", "tasks.register(\"integrationTest\"", "tasks.named(\"test\") {",
  "rootProject.name = 'x'\ninclude", "include(", "include '", "java {\n  sourceCompatibility", "sourceCompatibility = JavaVersion", "id 'jacoco'\nid", "id 'checkstyle'\nid", "<build>\n<plugins>\n<plugin>\n<artifactId>",
  "Resources:", "Type: AWS::DynamoDB::Table", "AttributeType", "KeyType", "KeySchema:", "AWSTemplateFormatVersion", "resource \"aws_dynamodb_table\" \"x\" {", "attribute {", "hash_key", "new Table(this,", "new Bucket(this,", "aws-cdk-lib",
  "<dependency>", "<artifactId>", "<groupId>", "<plugin>", "<java.version>", "spring.redis.", "spring:", "ConnectionStrings", "environment:", "ports:", "depends_on:", "volumes:", "jobs:", "docker:", "build:",
  "DATABASE_URL=", "REDIS_URL=", "export", "postgres://", "jdbc:", "redis://", "http://", "https://", "host=", "Host:", "Addr:", "Brokers:", "bootstrap.servers", "psycopg2", "pymongo", "redis", "kafkajs", "amqplib",
  "module", "go ", "toolchain", "replace", "pytest", "[tool.pytest.ini_options]", "[project]", "[tool.poetry]", "[tool.ruff", "scripts", "\"scripts\":", "\"test\":", "rootProject.name", "include(", "includeBuild",
];
const KEYWORD_BODIES: Record<string, string> = {};
for (const keyword of KEYWORDS) {
  for (const [name, unit] of [["spaces", " "], ["newlines", "\n"]] as const) KEYWORD_BODIES[`kw:${keyword}+${name}`] = (keyword + unit.repeat(SIZE - keyword.length - 1) + "x").slice(0, SIZE);
}
// Small, ordinary files that let a detector get past its early exits (a Java build only looks closely when there are tests; so do the Python and Go ones), so the hostile file is really read.
const COMPANIONS: Files = { "src/test/java/AT.java": "class AT {}\n", "tests/test_a.py": "def test_a():\n    pass\n", "pkg/x_test.go": "package x\n", "src/ok.test.ts": "export {};\n" };
// Every file kind gets every body: a detector only reads the kinds it knows, so most pairs are fast, and any pair that is not is a bug.
const ALL_BODIES = { ...BODIES, ...KEYWORD_BODIES };

// The limits above are for a developer machine. A shared CI runner running several test files at once is several times slower (0.5.11 CI runs: the same 256 KiB
// newline parse took 150 ms here and 1.0 to 1.3 s there, against a 1 s limit), and no in-process calibration tracked that (a JS loop read ~1x). So on CI (`CI` set)
// each pair is judged against a fixed cap of MAX_SLOWDOWN x its limit; on a developer machine (the full local suite runs before every release) against the limit itself,
// so mild regressions are still caught there. Either way a pair over its bar is timed once more and the faster run is judged. The failures this test exists for took
// 26 s to minutes, past every bar.
const MAX_SLOWDOWN = 4;
const ON_CI = process.env["CI"] !== undefined && process.env["CI"] !== "" && process.env["CI"] !== "false";
async function timed(files: Files): Promise<number> {
  const started = performance.now();
  await detect(files);
  return performance.now() - started;
}

describe("no detector is slow on a hostile file of the largest size the reader allows", () => {
  for (const name of FILES) {
    it(`${name}`, async () => {
      const slow: string[] = [];
      for (const [label, body] of Object.entries(ALL_BODIES)) {
        const files = { ...COMPANIONS, [name]: body };
        let took = await timed(files);
        const bar = limitFor(label) * (ON_CI ? MAX_SLOWDOWN : 1);
        if (took > bar) took = Math.min(took, await timed(files));
        if (took > bar) slow.push(`${label}: ${String(Math.round(took))} ms (limit ${String(Math.round(bar))} ms${ON_CI ? " on CI" : ""})`);
      }
      expect(slow).toEqual([]);
    }, 3_600_000);
  }
});

describe("test-side fake hosts never carry user information", () => {
  const user = ["jane", "doe"].join(".");
  const password = ["pw", "z".repeat(14), "5"].join("-");
  const jwtish = ["eyJ", "a".repeat(12)].join("") + "." + "b".repeat(12);
  it.each([
    ["responses.add", `import responses\nresponses.add(responses.GET, "https://${user}:${password}@api.partner.example.net/x")\n`, "tests/test_a.py"],
    ["requests_mock", `requests_mock.get("https://${user}@api.partner.example.net/x")\n`, "tests/test_b.py"],
    ["nock", `nock("https://${user}:${password}@api.partner.example.net").get("/x")\n`, "src/a.test.ts"],
    ["msw", `http.get("https://${jwtish}@api.partner.example.net/x", () => {})\n`, "src/b.test.ts"],
    ["a dotted token before the at sign", `nock("https://${jwtish}@host.example.net")\n`, "src/c.test.ts"],
  ])("%s", async (_label, text, path) => {
    const detection = await detect({ [path]: text });
    const out = JSON.stringify(detection);
    for (const secret of [user, password, jwtish, "partner"]) expect(out).not.toContain(secret);
    expect(detection.dependencies?.some((item) => item.family.startsWith("http:"))).toBeFalsy();
  });
  it("still takes an ordinary host, with a port or a path", async () => {
    const detection = await detect({ "src/a.test.ts": 'nock("https://api.partner.example.net:8443/v1").get("/x")\nnock(`http://other.example.net?x=1`)\n' });
    expect(detection.dependencies!.map((item) => item.family).sort()).toEqual(["http:api.partner.example.net", "http:other.example.net"]);
  });
});

describe("variable names must look like variable names", () => {
  it("drops lower-case keys, one-letter names and long run-together names, keeps ordinary ones", () => {
    const pasted = ["HUNTER", "TWO", "PW", "1234567890"].join("");
    expect(["hunter2PW", "A", "DATABASE_URL", "PG1", pasted, "ABCDEFGHIJKLMNOPQRSTUVWXYZAB", "REDIS_URL_2"].map(safeEnvName)).toEqual([undefined, undefined, "DATABASE_URL", "PG1", undefined, undefined, "REDIS_URL_2"]);
  });
  it("keeps such a key out of a compose list entry and an env file", async () => {
    const pasted = ["HUNTER", "TWO", "PW", "1234567890"].join("");
    const compose = `services:\n  db:\n    image: postgres\n    environment:\n      - hunter2PW=x\n      - ${pasted}=y\n      - POSTGRES_DB=app\n`;
    const detection = await detect({ "docker-compose.yml": compose, ".env": `${pasted}=1\nhunter2PW=1\nREDIS_URL=1\n` });
    expect(family(detection, "postgres")!.hints.envNames).toEqual(["POSTGRES_DB"]);
    const out = JSON.stringify(detection);
    expect(out).not.toContain(pasted);
    expect(out).not.toContain("hunter2PW");
  });
});

describe("limits that need their own test", () => {
  it("refuses a wide, shallow YAML document on the node count alone", () => {
    const items = Array.from({ length: YAML_LIMITS.maxNodes + 100 }, () => "- a").join("\n");
    expect(Buffer.byteLength(items)).toBeLessThan(YAML_LIMITS.maxBytes);
    expect(parseSafeYaml(items)).toEqual({ ok: false, reason: "too_many_nodes" });
  });
  it("does not read a dev container's compose file that is not in the path list, even if the reader would serve it", async () => {
    const reads: string[] = [];
    const reader: RepositoryReader = {
      paths: [".devcontainer/devcontainer.json"],
      read: (path) => { reads.push(path); return Promise.resolve(path.endsWith("devcontainer.json") ? '{"dockerComposeFile": "../stack/dev.yml"}' : "services:\n  db: { image: postgres }\n"); },
    };
    expect(await detectCompose({ repo: reader, cwd: "svc" })).toEqual({});
    expect(reads).toEqual([".devcontainer/devcontainer.json"]);
  });
  it("says so when the shared read budget ran out", async () => {
    const files: Files = {};
    const each = ENV_DETECT_MAX_FILE_BYTES - 10;
    for (let index = 0; index <= Math.ceil(ENV_DETECT_MAX_TOTAL_BYTES / each); index += 1) files[`docs/f${String(index)}.txt`] = "x".repeat(each);
    files["docker-compose.yml"] = "services:\n  db: { image: postgres }\n";
    const bounded = boundedReader(["docs/a.md", ...Object.keys(files)], (path) => Promise.resolve(files[path]));
    for (const path of Object.keys(files).filter((name) => name.startsWith("docs/"))) await bounded.reader.read(path);
    const detection = await runDetectors(bounded.reader, "svc");
    expect(detection.notes).toContain("Some files were not read: the read budget ran out.");
    expect((await detect({ "docker-compose.yml": "services:\n  db: { image: postgres }\n" })).notes.join(" ")).not.toContain("read budget");
  });
});

describe("infrastructure resource names are carried, but never a key-shaped one", () => {
  const keyName = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
  it("falls back from a key-shaped physical name to the template's id, and drops a resource with neither (its service stays a candidate with no resource)", async () => {
    const template = `Resources:\n  Orders:\n    Type: AWS::SQS::Queue\n    Properties:\n      QueueName: ${keyName}\n  ${keyName}:\n    Type: AWS::SNS::Topic\n    Properties:\n      TopicName: ${keyName}\n`;
    const detection = await detect({ "template.yaml": template });
    expect(family(detection, "aws:sqs")!.hints.resources).toEqual([{ kind: "queue", name: "Orders" }]);
    expect(family(detection, "aws:sns")!.hints.resources).toBeUndefined();
    expect(JSON.stringify(detection)).not.toContain(keyName);
  });
  it("applies the same rule to Terraform and CDK names", async () => {
    const tf = `resource "aws_sqs_queue" "q" {\n  name = "${keyName}"\n}\n`;
    const cdk = `import { Queue } from "aws-cdk-lib/aws-sqs";\nnew Queue(this, "${keyName}", { queueName: "${keyName}" });\n`;
    const detection = await detect({ "main.tf": tf, "lib/stack.ts": cdk });
    expect(family(detection, "aws:sqs")!.hints.resources).toEqual([{ kind: "queue", name: "q" }]);
    expect(JSON.stringify(detection)).not.toContain(keyName);
  });
});

describe("realistic wide spacing is still understood", () => {
  const blanks = (count: number): string => " ".repeat(count);
  it.each([60, 120])("%i blanks inside a call: environment names, boto3 clients, driver hosts, Go and Node calls", async (count) => {
    const pad = blanks(count);
    const detection = await detect({
      "app/settings.py": `import os\nCACHE = os.environ.get(${pad}'REDIS_URL')\n`,
      "svc/aws.py": `import boto3\nclient = boto3.client(${pad}"sqs", region_name="us-east-1")\n`,
      "svc/db.py": `import psycopg2\nconn = psycopg2.connect${pad}(host="db.internal")\n`,
      "main.go": `package main\nimport "github.com/redis/go-redis/v9"\nfunc f() { _ = redis.NewClient${pad}(&redis.Options{Addr: "localhost:6379"}) }\n`,
      "src/mq.js": `const amqp = require("amqplib");\namqp.connect${pad}("amqp://rabbit");\n`,
    });
    expect(family(detection, "redis")!.hints.envNames).toContain("REDIS_URL");
    expect(family(detection, "aws:sqs")).toBeDefined();
    expect(family(detection, "postgres")!.hints.explicitEndpoint).toBe(true);
    expect(family(detection, "redis")!.hints.explicitEndpoint).toBe(true);
    expect(family(detection, "rabbitmq")!.hints.explicitEndpoint).toBe(true);
  });
  it("60 blanks after Gradle's sourceCompatibility, and 120 blanks or line ends inside Maven tags", async () => {
    const gradle = await detect({ "build.gradle": `sourceCompatibility${blanks(60)}=${blanks(60)}17\n`, "src/test/java/AT.java": "class AT {}\n" });
    expect(gradle.notes.join(" ")).toContain("Java 17");
    for (const count of [60, 120]) {
      const pad = `${blanks(count - 1)}\n`;
      const pom = `<project>\n<properties><java.version>${pad}17${pad}</java.version></properties>\n<modules><module>${pad}api${pad}</module></modules>\n<dependencies><dependency><groupId>${pad}org.postgresql${pad}</groupId><artifactId>${pad}postgresql${pad}</artifactId></dependency></dependencies>\n</project>\n`;
      const detection = await detect({ "pom.xml": pom, "src/test/java/AT.java": "class AT {}\n" });
      expect(detection.notes.join(" ")).toContain("Java 17");
      expect(detection.notes.join(" ")).toContain("1 module: api");
      expect(family(detection, "postgres")).toBeDefined();
    }
  });
});
