// Test-side fakes and Testcontainers detector (test services D6; design test-services.md 3.2). Reads only the project's TEST files (test folders, `*.test.*` / `*.spec.*`, `test_*.py`, `*_test.go`, `*Test.java`,
// `conftest.py`) and says two different things:
//   - an IN-PROCESS FAKE (an AWS mock decorator, a stubbed client, a mocked driver module, an in-memory server, an HTTP interceptor) means the tests already stand in for that dependency: the candidate carries
//     `fakedByTests`, and Rovara starts nothing for it (the evidence says "faked by your tests");
//   - TESTCONTAINERS means the tests start their own containers, which cannot run inside Rovara: the candidate carries `testcontainers`, and Rovara starts the same service itself and points the tests at it.
// Only names and numbers leave this file (a family, a major version from an image literal, a line). No host, URL query, token or other value is kept; an HTTP interceptor's host is a family (`http:<host>`) and
// only when it is written as a plain https or http host of at least two labels. Nothing is run.
import { awsClientCandidate, callArguments, candidate, familyFromImage, mergeCandidates, normalizeAwsService } from "./dependency-candidates.js";
import { lineOf, type DependencyCandidate, type DependencyHints, type Detector } from "./types.js";

const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|integration|src\/test|testing)\/|(?:^|\/)conftest\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|(?:Tests?|IT)\.(?:java|kt)$/u;
const CODE_FILE = /\.(?:py|[cm]?[jt]sx?|java|kt|go)$/u;
const SKIP_DIRS = /(?:^|\/)(?:node_modules|dist|build|\.git|venv|\.venv|vendor|\.tox|__pycache__)\//u;
export const TEST_FAKES_MAX_FILES = 300;
/** The AWS services moto has a `mock_<service>` decorator for that matter here; any other `mock_<word>` is an ordinary mock, not an AWS fake. */
const MOTO_SERVICES = new Set(["s3", "dynamodb", "sqs", "sns", "sts", "secretsmanager", "ssm", "kms", "events", "lambda", "kinesis", "stepfunctions", "apigateway", "cognitoidp", "logs", "ses", "sesv2", "rds", "ec2", "iam", "cloudwatch", "firehose", "ecr", "ecs", "elasticache", "es", "athena", "glue", "route53", "cloudformation", "batch", "sagemaker", "dynamodbstreams"]);

type Hit = DependencyCandidate;
const fake = (family: string, path: string, text: string, index: number, extra: DependencyHints = {}): Hit => candidate(family, "used", { path, line: lineOf(text, index) }, { fakedByTests: true, ...extra, seenBy: ["test"] });
const container = (family: string, path: string, text: string, index: number, version?: string): Hit => candidate(family, "used", { path, line: lineOf(text, index) }, { testcontainers: true, ...(version === undefined ? {} : { version }), seenBy: ["test"] });

// ---- in-process fakes

/** A module / class / import path that names a driver, to the family it stands for. Used for `patch("a.b.redis.Redis")`, `jest.mock("ioredis")` and the like. */
const DRIVER_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:psycopg2?|asyncpg|pg8000|pg|pg-promise|postgres|pgx)\b/u, "postgres"],
  [/\b(?:pymysql|MySQLdb|mysql2?|aiomysql|mysql\.connector)\b/u, "mysql"],
  [/\b(?:redis|ioredis|aioredis|valkey|go-redis)\b/u, "redis"],
  [/\b(?:pymongo|motor|mongoose|mongodb|MongoClient)\b/u, "mongodb"],
  [/\b(?:kafka|kafkajs|confluent_kafka|aiokafka)\b/u, "kafka"],
  [/\b(?:pika|aio_pika|amqplib|amqp)\b/u, "rabbitmq"],
  [/\b(?:elasticsearch|opensearch)\b/u, "elasticsearch"],
  [/\b(?:pymemcache|memcache|memcached)\b/u, "memcached"],
];
function driverFamily(target: string): string | undefined {
  for (const [pattern, family] of DRIVER_WORDS) if (pattern.test(target)) return family;
  return undefined;
}

const MOCK_LIBRARIES: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:fakeredis|ioredis-mock|redis-mock|redismock|miniredis|jedis-mock|embedded-redis)\b/u, "redis"],
  [/\b(?:mongomock|mongodb-memory-server|embed\.mongo|mongo-java-server)\b/u, "mongodb"],
  [/\b(?:pg-mem|testing\.postgresql|embedded-postgres|zonky)\b/u, "postgres"],
  [/\b(?:EmbeddedKafka|embedded-kafka|kafka-junit)\b/u, "kafka"],
];

function pythonFakes(path: string, text: string): Hit[] {
  const found: Hit[] = [];
  // moto: `@mock_s3`, `mock_dynamodb()`, `mock_aws` (services then come from the boto3 clients the file builds).
  for (const match of text.matchAll(/\bmock_([a-z0-9_]+)\b/gu)) {
    const service = match[1]!.replace(/(?:2|_deprecated)$/u, "");
    if (!MOTO_SERVICES.has(service)) continue;
    const item = awsClientCandidate(path, text, match.index, service === "cognitoidp" ? "cognito-idp" : service, false);
    if (item !== undefined) found.push({ ...item, hints: { fakedByTests: true, seenBy: ["test"] } });
  }
  const awsFake = /\bmock_aws\b|\bbotocore\.stub\b|\bStubber\s{0,120}\(|\bmotoserver\b|\bmoto\b/u.exec(text);
  if (awsFake !== null) {
    for (const match of text.matchAll(/\.(?:client|resource)\(\s{0,120}(?:service_name\s{0,40}=\s{0,40})?["']([A-Za-z0-9_-]+)["']/gu)) {
      const item = awsClientCandidate(path, text, awsFake.index, match[1]!, false);
      if (item !== undefined) found.push({ ...item, hints: { fakedByTests: true, seenBy: ["test"] } });
    }
  }
  for (const match of text.matchAll(/\b(?:patch|patch\.object|mocker\.patch|monkeypatch\.setattr)\(\s{0,120}["']([A-Za-z0-9_.]+)["']/gu)) {
    const family = driverFamily(match[1]!);
    if (family !== undefined) found.push(fake(family, path, text, match.index));
  }
  for (const [pattern, family] of MOCK_LIBRARIES) { const match = pattern.exec(text); if (match !== null) found.push(fake(family, path, text, match.index)); }
  for (const match of text.matchAll(/\b(?:responses\.add|requests_mock\.[a-z]+|httpx_mock\.add_response)\(\s{0,120}(?:responses\.[A-Z]+\s{0,40},\s{0,40})?["']https?:\/\/([^/\s"'`?#)]*)/gu)) { const item = httpFake(match[1]!, path, text, match.index); if (item !== undefined) found.push(item); }
  return found;
}

/**
 * An interceptor's host as a family. The text after the scheme is read up to the first `/`, `?`, `#`, quote or space; if it holds an `@` it is user information (a user name, a password, a token), so the whole
 * match is dropped and nothing of it is kept. Only a plain host name of at least two labels, with an optional port, is accepted.
 */
function httpFake(authority: string, path: string, text: string, index: number): Hit | undefined {
  if (authority.includes("@") || authority.length > 260) return undefined;
  const lower = authority.replace(/:\d{1,5}$/u, "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(lower) || /^\d+(?:\.\d+)*$/u.test(lower) || lower.length > 200) return undefined;
  return fake(`http:${lower}`, path, text, index);
}

function nodeFakes(path: string, text: string): Hit[] {
  const found: Hit[] = [];
  // aws-sdk-client-mock: `mockClient(S3Client)`.
  for (const match of text.matchAll(/\bmockClient\(\s{0,120}([A-Za-z0-9]+?)(?:Document)?Client\b/gu)) {
    const item = awsClientCandidate(path, text, match.index, match[1]!, false);
    if (item !== undefined) found.push({ ...item, hints: { fakedByTests: true, seenBy: ["test"] } });
  }
  for (const match of text.matchAll(/\b(?:jest|vi)\.(?:mock|doMock)\(\s{0,120}["']([^"']+)["']/gu)) {
    const aws = /^@aws-sdk\/(?:client|lib)-([a-z0-9-]+)$/u.exec(match[1]!)?.[1];
    if (aws !== undefined) { const item = awsClientCandidate(path, text, match.index, aws, false); if (item !== undefined) found.push({ ...item, hints: { fakedByTests: true, seenBy: ["test"] } }); continue; }
    const family = driverFamily(match[1]!);
    if (family !== undefined) found.push(fake(family, path, text, match.index));
  }
  for (const [pattern, family] of MOCK_LIBRARIES) { const match = pattern.exec(text); if (match !== null) found.push(fake(family, path, text, match.index)); }
  for (const match of text.matchAll(/\bnock\(\s{0,120}["'`]https?:\/\/([^/\s"'`?#)]*)/gu)) { const item = httpFake(match[1]!, path, text, match.index); if (item !== undefined) found.push(item); }
  for (const match of text.matchAll(/\b(?:http|rest|graphql)\.(?:get|post|put|patch|delete)\(\s{0,120}["'`]https?:\/\/([^/\s"'`?#)]*)/gu)) { const item = httpFake(match[1]!, path, text, match.index); if (item !== undefined) found.push(item); }
  return found;
}

function javaFakes(path: string, text: string): Hit[] {
  const found: Hit[] = [];
  for (const match of text.matchAll(/\b(?:Mockito\.)?mock\(\s{0,120}([A-Za-z0-9]+?)(?:Async)?Client\.class/gu)) {
    const item = awsClientCandidate(path, text, match.index, match[1]!, false);
    if (item !== undefined) found.push({ ...item, hints: { fakedByTests: true, seenBy: ["test"] } });
  }
  for (const match of text.matchAll(/\bS3Mock\b|\bAdobeS3Mock\b/gu)) { const item = awsClientCandidate(path, text, match.index, "s3", false); if (item !== undefined) found.push({ ...item, hints: { fakedByTests: true, seenBy: ["test"] } }); break; }
  const embeddedKafka = /@EmbeddedKafka\b/u.exec(text);
  if (embeddedKafka !== null) found.push(fake("kafka", path, text, embeddedKafka.index));
  for (const [pattern, family] of MOCK_LIBRARIES) { const match = pattern.exec(text); if (match !== null) found.push(fake(family, path, text, match.index)); }
  return found;
}

function goFakes(path: string, text: string): Hit[] {
  const found: Hit[] = [];
  for (const [pattern, family] of MOCK_LIBRARIES) { const match = pattern.exec(text); if (match !== null) found.push(fake(family, path, text, match.index)); }
  return found;
}

// ---- Testcontainers

const CONTAINER_CLASSES: ReadonlyArray<[RegExp, string]> = [
  [/\bPostgre(?:s|SQL)Container\b/u, "postgres"],
  [/\b(?:MySQL|MySql|MariaDB|MariaDb)Container\b/u, "mysql"],
  [/\bRedis(?:Stack)?Container\b/u, "redis"],
  [/\b(?:MongoDB|MongoDb|Mongo)Container\b/u, "mongodb"],
  [/\b(?:Kafka|Redpanda)Container\b/u, "kafka"],
  [/\bRabbit(?:MQ|Mq)Container\b/u, "rabbitmq"],
  [/\b(?:Elasticsearch|ElasticSearch)Container\b/u, "elasticsearch"],
  [/\bOpenSearchContainer\b/u, "opensearch"],
];
const CONTAINER_MODULES: ReadonlyArray<[RegExp, string]> = [
  [/testcontainers(?:-go)?[./](?:modules[./])?(?:postgres|postgresql)\b/u, "postgres"],
  [/testcontainers(?:-go)?[./](?:modules[./])?(?:mysql|mariadb)\b/u, "mysql"],
  [/testcontainers(?:-go)?[./](?:modules[./])?redis\b/u, "redis"],
  [/testcontainers(?:-go)?[./](?:modules[./])?mongo(?:db)?\b/u, "mongodb"],
  [/testcontainers(?:-go)?[./](?:modules[./])?(?:kafka|redpanda)\b/u, "kafka"],
  [/testcontainers(?:-go)?[./](?:modules[./])?rabbitmq\b/u, "rabbitmq"],
  [/testcontainers(?:-go)?[./](?:modules[./])?elasticsearch\b/u, "elasticsearch"],
];

function testcontainers(path: string, text: string): Hit[] {
  if (!/testcontainers/iu.test(text)) return [];
  const found: Hit[] = [];
  for (const [pattern, family] of [...CONTAINER_CLASSES, ...CONTAINER_MODULES]) {
    const first = pattern.exec(text);
    if (first === null) continue;
    // A version from an image literal in a constructor, if one is written anywhere in the file (`PostgreSQLContainer("postgres:16")`).
    let version: string | undefined;
    for (const match of text.matchAll(new RegExp(pattern.source, "gu"))) {
      const open = text.indexOf("(", match.index + match[0].length - 1);
      const image = open < 0 || text.slice(match.index + match[0].length, Math.min(open, match.index + match[0].length + 2_000)).trim().replace(/<[^<>]{0,200}>/gu, "") !== "" ? undefined : /["']([A-Za-z0-9._/:@-]{2,100})["']/u.exec(callArguments(text, open, 300))?.[1];
      version = image === undefined ? undefined : familyFromImage(image)?.version;
      if (version !== undefined) break;
    }
    found.push(container(family, path, text, first.index, version));
  }
  // `GenericContainer("redis:7")`, `DockerContainer("postgres:16")`, `DockerImageName.parse("kafka:3")`, a request with `Image: "redis:7"`.
  for (const match of text.matchAll(/\b(?:GenericContainer|DockerContainer|DockerImageName\.parse|ContainerRequest)\b[^"'\n]{0,40}\(?\s{0,40}["']([A-Za-z0-9._/:@-]{2,100})["']|\bImage\s{0,40}:\s{0,40}"([A-Za-z0-9._/:@-]{2,100})"/gu)) {
    const image = familyFromImage(match[1] ?? match[2]);
    if (image !== undefined && image.family !== "localstack") found.push(container(image.family, path, text, match.index, image.version));
    else if (image?.localstack === true) found.push(...localstackServices(path, text, match.index));
  }
  if (/\bLocal[sS]tackContainer\b|testcontainers(?:-go)?[./](?:modules[./])?localstack/u.test(text)) found.push(...localstackServices(path, text, text.search(/Local[sS]tackContainer|localstack/u)));
  return found;
}

function localstackServices(path: string, text: string, index: number): Hit[] {
  const found: Hit[] = [];
  const names = new Set<string>();
  for (const match of text.matchAll(/\bService\.([A-Z0-9_]+)\b/gu)) names.add(match[1]!);
  for (const match of text.matchAll(/\bwith_?[sS]ervices\(([^)]{0,500})\)/gu)) for (const quoted of match[1]!.matchAll(/["']([A-Za-z0-9_-]+)["']/gu)) names.add(quoted[1]!);
  for (const name of names) {
    const id = normalizeAwsService(name);
    if (id !== undefined) found.push(container(`aws:${id}`, path, text, index));
  }
  return found;
}

export const detectTestFakes: Detector = async ({ repo }) => {
  const found: Hit[] = [];
  for (const path of repo.paths.filter((candidatePath) => CODE_FILE.test(candidatePath) && TEST_FILE.test(candidatePath) && !SKIP_DIRS.test(candidatePath)).slice(0, TEST_FAKES_MAX_FILES)) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    if (path.endsWith(".py")) found.push(...pythonFakes(path, text));
    else if (path.endsWith(".java") || path.endsWith(".kt")) found.push(...javaFakes(path, text));
    else if (path.endsWith(".go")) found.push(...goFakes(path, text));
    else found.push(...nodeFakes(path, text));
    found.push(...testcontainers(path, text));
  }
  const dependencies = mergeCandidates(found);
  if (dependencies.length === 0) return {};
  const notes: string[] = [];
  if (dependencies.some((item) => item.hints.testcontainers === true)) notes.push("Some tests start their own containers with Testcontainers, which cannot run inside Rovara. Rovara starts the same service itself and points the tests at it.");
  if (dependencies.some((item) => item.hints.fakedByTests === true)) notes.push("Some tests already fake a dependency inside their own process. Rovara starts nothing for it, and the result says it was faked by the tests.");
  return { dependencies, notes };
};
