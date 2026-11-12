// Test services detectors: every detector stays fast as a hostile file grows. A backtracking pattern (`^\s*` with the `m` flag, `[\s\S]*` inside a lookahead, two unbounded
// repeats side by side) blocks the thread while it runs, so no test timeout can fire: the only defence is to fail at a small size before a large one hangs. Each file kind gets
// a short lead that takes the detectors past their early exits (the file must be read and look like what it is), then a filler, at growing sizes; the first case over the bar
// fails the test, so a cubic pattern stops the run at 4 KiB in a second or two instead of hanging at 64 KiB. The 256 KiB sweep of every body is in worker-env-detect-hardening.
import { describe, expect, it } from "vitest";
import { DETECTORS, boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
const SIZES = [1_024, 4_096, 16_384, 65_536] as const;
const ON_CI = process.env["CI"] !== undefined && process.env["CI"] !== "" && process.env["CI"] !== "false";
const BAR_MS = ON_CI ? 1_000 : 250;

// Small, ordinary files that let a detector get past its early exits (a Java or Go build only looks closely when there are tests, Python wants a test file), so the hostile file is really read.
const COMPANIONS: Files = { "src/test/java/AT.java": "class AT {}\n", "tests/test_a.py": "def test_a():\n    pass\n", "pkg/x_test.go": "package x\n", "src/ok.test.ts": "export {};\n" };

// Per file kind: the lead (what the file starts with), a word the detectors look for (repeated with blanks after it as a filler), openers a detector's pattern starts at (repeated with
// no closer as a filler) and a tail (what closes the file, so JSON stays JSON).
interface Kind { path: string; lead: string; word: string; open?: readonly string[]; tail?: string }
const KINDS: readonly Kind[] = [
  // Python
  { path: "pyproject.toml", lead: "[project]\nname = \"x\"\ndependencies = [\n  \"psycopg2\",\n", word: "pytest", tail: "]\n[tool.pytest.ini_options]\naddopts = \"-q\"\n" },
  { path: "requirements.txt", lead: "psycopg2==2.9\nredis\n", word: "boto3" },
  { path: "Pipfile", lead: "[packages]\npsycopg2 = \"*\"\n", word: "redis" },
  { path: "setup.cfg", lead: "[tool:pytest]\naddopts = -q\n", word: "flake8" },
  { path: "tox.ini", lead: "[tox]\nenvlist = py311\n[testenv]\ncommands = pytest\n", word: "pytest" },
  { path: "pytest.ini", lead: "[pytest]\naddopts = -q\n", word: "markers" },
  { path: "app/settings.py", lead: "DATABASES = {\"default\": {\"ENGINE\": \"django.db.backends.postgresql\", \"HOST\": \"db\"}}\nimport os\nos.environ[\"REDIS_URL\"]\n", word: "os.environ.get(" },
  { path: "app/service.py", lead: "import boto3\nclient = boto3.client(\"sagemaker-runtime\")\nclient.invoke_endpoint(EndpointName=\"x\")\n", word: "boto3.client(" },
  { path: "tests/test_b.py", open: ["responses.add(", "@mock_aws ", "boto3.client("], lead: "import boto3\nfrom moto import mock_aws\nfrom testcontainers.postgres import PostgresContainer\nimport responses\n", word: "responses.add(" },
  { path: "inference.py", lead: "import json\ndef model_fn(model_dir):\n    pass\ndef input_fn(body, content_type):\n    pass\ndef predict_fn(data, model):\n    pass\n", word: "def" },
  // Node
  { path: "package.json", lead: "{\"name\": \"x\", \"scripts\": {\"test\": \"jest\", \"lint\": \"eslint .\"},", word: "", tail: "\"dependencies\": {\"pg\": \"8\", \"aws-cdk-lib\": \"2\"}}" },
  { path: "src/a.ts", lead: "import { S3Client } from \"@aws-sdk/client-s3\";\nconst url = process.env.DATABASE_URL;\n", word: "import" },
  { path: "src/b.test.ts", open: ["nock(", "http.get(", "vi.mock("], lead: "import nock from \"nock\";\nimport { GenericContainer } from \"testcontainers\";\nnock(\"https://api.example.net\");\n", word: "nock(" },
  { path: "knexfile.js", lead: "module.exports = { client: \"pg\",\n", word: "client:", tail: "};\n" },
  { path: "prisma/schema.prisma", lead: "datasource db {\n  provider = \"postgresql\"\n  url = env(\"DATABASE_URL\")\n}\n", word: "provider" },
  // Java
  { path: "pom.xml", open: ["<plugin>", "<dependency>", "<profiles>", "<execution>"], lead: "<project><properties><java.version>17</java.version></properties><dependencies><dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency>", word: "<dependency>", tail: "</dependencies></project>\n" },
  { path: "build.gradle", open: ["xml {", "xml{required", "finalizedBy ", "id '", "plugins {"], lead: "plugins {\n  id 'java'\n  id 'jacoco'\n}\njava {\n  sourceCompatibility = JavaVersion.VERSION_17\n}\ndependencies {\n  implementation 'org.postgresql:postgresql:42.7.1'\n", word: "implementation", tail: "}\n" },
  { path: "build.gradle.kts", open: ["xml {", "tasks.register<Test>(", "id(\""], lead: "plugins {\n  java\n  id(\"jacoco\")\n}\ndependencies {\n  testImplementation(\"org.testcontainers:postgresql:1.19.0\")\n", word: "testImplementation", tail: "}\n" },
  { path: "settings.gradle", lead: "rootProject.name = 'x'\ninclude 'a'\n", word: "include" },
  { path: "src/main/java/App.java", lead: "import software.amazon.awssdk.services.s3.S3Client;\nclass App { S3Client c = S3Client.builder().build(); }\n", word: "S3Client" },
  { path: "src/test/java/BT.java", open: ["PostgreSQLContainer<", "withServices(", "@Container "], lead: "import org.testcontainers.containers.PostgreSQLContainer;\nclass BT { PostgreSQLContainer<?> db = new PostgreSQLContainer<>(\"postgres:16\"); }\n", word: "PostgreSQLContainer" },
  { path: "src/main/resources/application.yml", lead: "spring:\n  datasource:\n    url: jdbc:postgresql://db:5432/x\n", word: "spring:" },
  { path: "src/main/resources/application.properties", lead: "spring.datasource.url=jdbc:postgresql://db:5432/x\nspring.redis.host=cache\n", word: "spring.redis.host=" },
  { path: "appsettings.json", lead: "{\"ConnectionStrings\": {\"Postgres\": \"Host=db;Database=x\"},", word: "", tail: "\"Logging\": {}}" },
  // Go
  { path: "go.mod", open: ["require (", "replace "], lead: "module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/lib/pq v1.10.9\n", word: "require", tail: ")\n" },
  { path: "go.work", lead: "go 1.22\n\nuse (\n\t.\n", word: "use", tail: ")\n" },
  { path: "main.go", lead: "package main\n\nimport (\n\t\"github.com/aws/aws-sdk-go-v2/service/s3\"\n)\n", word: "import" },
  { path: "pkg/y_test.go", lead: "package x\n\nimport \"github.com/testcontainers/testcontainers-go/modules/postgres\"\n", word: "postgres.Run(" },
  // Containers, CI, environment files
  { path: "docker-compose.yml", lead: "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: x\n", word: "image:" },
  { path: ".devcontainer/devcontainer.json", lead: "{\"dockerComposeFile\": \"../docker-compose.yml\",", word: "", tail: "\"service\": \"app\"}" },
  { path: ".github/workflows/ci.yml", lead: "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: postgres:16\n", word: "services:" },
  { path: ".gitlab-ci.yml", lead: "test:\n  services:\n    - postgres:16\n  script:\n    - pytest\n", word: "services:" },
  { path: ".circleci/config.yml", lead: "version: 2.1\njobs:\n  test:\n    docker:\n      - image: cimg/python:3.12\n      - image: postgres:16\n", word: "image:" },
  { path: ".env", lead: "DATABASE_URL=postgres://db:5432/x\nREDIS_URL=redis://cache:6379\n", word: "export" },
  { path: ".env.example", lead: "DATABASE_URL=postgres://db:5432/x\n", word: "DATABASE_URL=" },
  { path: "config/app.yaml", lead: "endpoint: https://api.partner.example.net/v1\n", word: "endpoint:" },
  // Infrastructure as code and seeds
  { path: "template.yaml", lead: "AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  Table:\n    Type: AWS::DynamoDB::Table\n    Properties:\n      TableName: t\n", word: "Type:" },
  { path: "cdk.out/a.template.json", lead: "{\"Resources\": {\"B\": {\"Type\": \"AWS::S3::Bucket\", \"Properties\": {\"BucketName\": \"b\"}}},", word: "", tail: "\"Outputs\": {}}" },
  { path: "main.tf", open: ["resource \"aws_", "attribute {"], lead: "resource \"aws_dynamodb_table\" \"t\" {\n  name = \"t\"\n  hash_key = \"id\"\n", word: "attribute", tail: "}\n" },
  { path: "lib/stack.ts", lead: "import * as cdk from \"aws-cdk-lib\";\nnew cdk.aws_s3.Bucket(this, \"B\", { bucketName: \"b\" });\n", word: "new" },
  { path: "infra/app_stack.py", lead: "import aws_cdk as cdk\nfrom aws_cdk import aws_dynamodb as dynamodb\ndynamodb.Table(self, \"T\", table_name=\"t\")\n", word: "dynamodb.Table(" },
  { path: "db/seeds/users.sql", lead: "INSERT INTO users (id) VALUES (1);\n", word: "INSERT" },
  // SageMaker (lands with the SageMaker detector): a serving Dockerfile.
  { path: "Dockerfile", open: ["EXPOSE ", "CMD ["], lead: "FROM python:3.12-slim\nEXPOSE 8080\n", word: "FROM", tail: "ENTRYPOINT [\"serve\"]\n" },
];

// A file only a detector that has not landed yet reads (the SageMaker serving container's Dockerfile). It is timed all the same, so that detector is covered the day it lands.
const NOT_READ_YET: ReadonlySet<string> = new Set(["Dockerfile"]);

// Fillers: runs of line breaks and blanks (what `^\s*` and `\s*$` with the `m` flag choke on), one repeated character, openers with no closer (what `open[^close]*` rescans from),
// and the kind's own word and openers.
const FILLERS = (kind: Kind): Array<[string, string]> => [
  ["newlines", "\n"], ["space-newline", " \n"], ["tab-newline", "\t\n"], ["crlf", "\r\n"], ["spaces", " "], ["tabs", "\t"], ["letter", "a"],
  ...["{", "(", "[", "<", "\"", "'", "${", "/*", "<!--"].map((unit): [string, string] => [`opener ${unit}`, unit]),
  ...(kind.word === "" ? [] : [["word+spaces", `${kind.word}  `], ["word+newline", `${kind.word}\n`]] as Array<[string, string]>),
  ...(kind.open ?? []).map((unit): [string, string] => [`opener ${unit}`, unit]),
];

function body(kind: Kind, unit: string, size: number): string {
  const tail = kind.tail ?? "";
  const room = Math.max(0, size - kind.lead.length - tail.length);
  return kind.lead + unit.repeat(Math.ceil(room / unit.length)).slice(0, room) + tail;
}

const read = new Set<string>();
async function timed(files: Files): Promise<number> {
  const bounded = boundedReader(Object.keys(files), (path) => { read.add(path); return Promise.resolve(files[path]); });
  const started = performance.now();
  await runDetectors(bounded.reader, "svc");
  return performance.now() - started;
}

describe("every detector stays fast as a hostile file grows", () => {
  it("reaches every detector: each one reads at least one of the file kinds below", async () => {
    expect(new Set(KINDS.map((kind) => kind.path)).size).toBe(KINDS.length);
    const files: Files = { ...COMPANIONS, ...Object.fromEntries(KINDS.map((kind) => [kind.path, body(kind, "\n", 256)])) };
    const unread: string[] = [];
    for (const detector of DETECTORS) {
      const seen = new Set<string>();
      const bounded = boundedReader(Object.keys(files), (path) => { seen.add(path); return Promise.resolve(files[path]); });
      await runDetectors(bounded.reader, "svc", { only: [detector.name] });
      if (!KINDS.some((kind) => seen.has(kind.path))) unread.push(detector.name);
    }
    expect(unread).toEqual([]);
  });
  for (const kind of KINDS) {
    it(kind.path, async () => {
      for (const [label, unit] of FILLERS(kind)) {
        for (const size of SIZES) {
          const files = { ...COMPANIONS, [kind.path]: body(kind, unit, size) };
          let took = await timed(files);
          // A case a little over the bar is timed once more (a busy machine), and the faster run is judged; one far over it is not worth a second wait.
          if (took > BAR_MS && took < 4 * BAR_MS) took = Math.min(took, await timed(files));
          // Stop at the first case over the bar: a larger size would only take longer, and a backtracking pattern cannot be interrupted.
          if (took > BAR_MS) expect.fail(`${kind.path} with ${label} at ${String(size)} bytes took ${String(Math.round(took))} ms (bar ${String(BAR_MS)} ms${ON_CI ? " on CI" : ""})`);
        }
      }
      // The file was really read by some detector: a kind no detector reads would pass without testing anything.
      if (!NOT_READ_YET.has(kind.path)) expect(read.has(kind.path), `${kind.path} was never read`).toBe(true);
    }, 120_000);
  }
});
