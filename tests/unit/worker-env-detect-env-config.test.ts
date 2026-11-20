// Test services TS9 (D3): the env and settings reader. Names only from real env files; values never copied; a URL gives its scheme and host family and nothing else.
import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { connectionUrls, familyOfName, hostFamily } from "../../packages/worker/src/env-detect/env-config.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

// Fake secrets are built at runtime so no key-shaped string sits in this file.
const PASSWORD = ["pw", "m".repeat(18), "Q4"].join("-");
const TOKEN = ["sk", "live", "B".repeat(26)].join("_");
const HOST = ["db", "internal", "customer-prod", "example-corp"].join(".") + ".net";

describe("example and sample env files", () => {
  const text = [
    "# connection settings",
    `DATABASE_URL=postgres://app:${PASSWORD}@${HOST}:5432/app`,
    `REDIS_URL="redis://:${PASSWORD}@localhost:6379/0"`,
    "AMQP_URL=amqp://guest:guest@rabbit:5672/",
    "KAFKA_BROKERS=broker-1:9092",
    "export MONGO_URI=mongodb+srv://u:p@cluster0.abcde.mongodb.net/db",
    "AWS_ENDPOINT_URL_S3=http://localhost:4566",
    "AWS_REGION=us-east-1",
    `STRIPE_API_KEY=${TOKEN}`,
    "APP_API_KEY=abc",
    "LOG_LEVEL=debug",
    "",
  ].join("\n");

  it("finds each connection setting by name or URL scheme, with its line, and the URL as scheme and host family only", async () => {
    const detection = await detect({ ".env.example": text });
    expect(family(detection, "postgres")).toMatchObject({ kind: "database", strength: "used", evidence: [{ path: ".env.example", line: 2 }], hints: { envNames: ["DATABASE_URL"], url: { scheme: "postgres", hostFamily: "unknown" }, seenBy: ["env"] } });
    expect(family(detection, "redis")!.hints).toMatchObject({ envNames: ["REDIS_URL"], url: { scheme: "redis", hostFamily: "local" } });
    expect(family(detection, "rabbitmq")!.hints.url).toEqual({ scheme: "amqp", hostFamily: "private" });
    expect(family(detection, "kafka")!.hints).toMatchObject({ envNames: ["KAFKA_BROKERS"] });
    expect(family(detection, "mongodb")!.hints.url).toEqual({ scheme: "mongodb+srv", hostFamily: "cloud" });
    expect(family(detection, "aws:s3")!.hints.envNames).toEqual(["AWS_ENDPOINT_URL_S3"]);
    expect(family(detection, "stripe")).toMatchObject({ kind: "http_api", hints: { envNames: ["STRIPE_API_KEY"] } });
    expect(detection.dependencies!.map((item) => item.family)).not.toEqual(expect.arrayContaining(["app", "aws"]));
  });

});

describe("settings files", () => {
  it("reads Django settings: engines, environment names and URL literals", async () => {
    const text = ["import os", "DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql', 'HOST': os.environ.get('PGHOST')}}", "CACHES = {'default': {'BACKEND': 'django_redis.cache.RedisCache', 'LOCATION': env('REDIS_URL')}}", `CELERY_BROKER_URL = "amqp://guest:${PASSWORD}@${HOST}//"`, "SECRET_KEY = os.environ['SECRET_KEY']", ""].join("\n");
    const detection = await detect({ "app/settings.py": text });
    expect(family(detection, "postgres")!.hints.envNames).toEqual(["PGHOST"]);
    expect(family(detection, "redis")!.hints.envNames).toEqual(["REDIS_URL"]);
    expect(family(detection, "rabbitmq")!.hints.url).toEqual({ scheme: "amqp", hostFamily: "unknown" });
    expect(JSON.stringify(detection)).not.toContain(PASSWORD);
    expect(JSON.stringify(detection)).not.toContain(HOST);
  });
  it("reads Spring properties and YAML, including a jdbc URL and placeholders, without their values", async () => {
    const props = [`spring.datasource.url=jdbc:postgresql://localhost:5432/app`, `spring.datasource.password=${PASSWORD}`, "spring.rabbitmq.host=${RABBITMQ_HOST:localhost}", "spring.kafka.bootstrap-servers=k:9092", ""].join("\n");
    const yaml = "spring:\n  redis:\n    host: ${REDIS_HOST:cache}\n    password: " + PASSWORD + "\n";
    const detection = await detect({ "src/main/resources/application.properties": props, "src/main/resources/application-test.yml": yaml });
    expect(family(detection, "postgres")!.hints.url).toEqual({ scheme: "postgresql", hostFamily: "local" });
    expect(family(detection, "rabbitmq")!.hints.envNames).toEqual(["RABBITMQ_HOST"]);
    expect(family(detection, "kafka")).toBeDefined();
    expect(family(detection, "redis")!.hints.envNames).toEqual(["REDIS_HOST"]);
    expect(family(detection, "redis")!.evidence).toContainEqual({ path: "src/main/resources/application-test.yml", line: 2 });
    expect(JSON.stringify(detection)).not.toContain(PASSWORD);
  });
});

describe("helpers", () => {
  it("classifies host families without keeping the host", () => {
    expect(["localhost", "127.0.0.1", "[::1]", "10.1.2.3", "172.20.0.1", "192.168.0.9", "db", "x.internal", "x.svc.cluster.local", "a.us-east-1.rds.amazonaws.com", "example.org", "${HOST}", ""].map(hostFamily)).toEqual(["local", "local", "local", "private", "private", "private", "private", "private", "private", "cloud", "unknown", "unknown", "unknown"]);
  });
  it("skips a URL's user information and ignores web URLs", () => {
    expect(connectionUrls("a postgres://u:p@h:1/x and https://web.example.net and redis://r")).toEqual([{ family: "postgres", scheme: "postgres", hostFamily: "private" }, { family: "redis", scheme: "redis", hostFamily: "private" }]);
  });
  it("maps names to families and leaves generic keys alone", () => {
    expect(["PGHOST", "REDIS_PORT", "AWS_ENDPOINT_URL_DYNAMODB", "S3_BUCKET", "SAGEMAKER_ENDPOINT_NAME", "TWILIO_API_KEY", "AWS_REGION", "SECRET_API_KEY", "PGP_KEY", "LOG_LEVEL"].map(familyOfName)).toEqual(["postgres", "redis", "aws:dynamodb", "aws:s3", "aws:sagemaker-runtime", "twilio", undefined, undefined, undefined, undefined]);
  });
});
