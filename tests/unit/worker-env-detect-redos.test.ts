// Test services dependency detectors: no detector is slow on a hostile file of the largest size the reader allows (catastrophic regex backtracking, ReDoS).
// #1256: split from worker-env-detect-hardening (its fast security checks stay there, in every run). This sweep is in nightlyOnlyFiles: a full run leaves it
// out, a pull request runs it when the change reaches packages/worker/src/env-detect/, and the nightly job runs it every night.
import { describe, expect, it } from "vitest";
import { ENV_DETECT_MAX_FILE_BYTES, boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
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
  // the SageMaker detector's model signs (a cubic Dockerfile pattern hung this suite on PR #485)
  "Dockerfile", "inference.py",
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
// #1124: the release build (CodeBuild) sets CODEBUILD_BUILD_ID, not CI, and is as busy as a CI runner, so it gets the CI bar too.
const ON_CI = (process.env["CI"] !== undefined && process.env["CI"] !== "" && process.env["CI"] !== "false") || (process.env["CODEBUILD_BUILD_ID"] ?? "") !== "";
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
