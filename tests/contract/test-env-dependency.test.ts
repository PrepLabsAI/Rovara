// Test services TS1 (contract): the dependency and its backing, the rules of design 2.2, the less-safe fields, the list caps and the reader of today's v1 services.
import { describe, expect, it } from "vitest";
import * as dep from "../../packages/contracts/src/test-env-dependency.js";
import * as shared from "../../packages/contracts/src/test-services-shared.js";
import { TestEnvServiceSchema, type TestEnvService } from "../../packages/contracts/src/test-environment.js";

const sha = (letter: string) => letter.repeat(64);
const base = (over: Record<string, unknown> = {}) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] },
  seeds: [], reset: "fresh_per_round", ...over,
});
const ok = (value: unknown) => dep.TestEnvDependencySchema.safeParse(value).success;
const fake = (extra: Record<string, unknown> = {}) => ({ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", ...extra });
const account = { kind: "test_account", accountId: "payments-test" };

describe("TestEnvDependency", () => {
  it("needs at least one source and one use", () => {
    expect(ok(base({ found: [] }))).toBe(false);
    expect(ok(base({ usedBy: [] }))).toBe(false);
    expect(ok(base({ usedBy: ["unit", "unit"] }))).toBe(false);
    expect(ok(base({ found: ["detector:compose", "model", "person"] }))).toBe(true);
    expect(ok(base({ found: ["detector:not valid"] }))).toBe(false);
  });
});

describe("families and identifiers", () => {
  it.each([""])("refuses the family %j", (family) => {
    expect(dep.FamilyIdSchema.safeParse(family).success).toBe(false);
  });
});

describe("backings", () => {
  it("keeps a local backing to real catalog software, not Rovara's own helpers", () => {
    for (const name of ["local-aws", "fake-server", "test-account-proxy", "dns-helper"]) expect(ok(base({ backing: { kind: "local", catalogId: `${name}@1`, config: {} } })), name).toBe(false);
  });
  it("lets an emulated backing run Rovara local AWS only, with each service once, for an AWS family that it lists", () => {
    const aws = (backing: Record<string, unknown>, extra: Record<string, unknown> = {}) => base({ id: "aws-s3", family: "aws:s3", kind: "object_store", backing: { kind: "emulated", catalogId: "local-aws@1", awsServices: ["s3"], region: "us-east-1", ...backing }, connect: { env: [], hostAliases: ["aws"] }, ...extra });
    expect(ok(aws({}))).toBe(true);
    expect(ok(aws({ catalogId: "postgres@16" }))).toBe(false);
    expect(ok(aws({ awsServices: ["s3", "s3"] }))).toBe(false);
    expect(ok(aws({ awsServices: [] }))).toBe(false);
    expect(ok(aws({ awsServices: ["sqs"] }))).toBe(false);
    expect(ok(aws({ awsServices: Array.from({ length: 25 }, (_, n) => `svc${String(n)}x`) }))).toBe(false);
    expect(ok(aws({ region: "US_EAST" }))).toBe(false);
    expect(ok(aws({}, { family: "postgres", kind: "database" }))).toBe(false);
  });
  it("describes a model endpoint with its endpoint name", () => {
    const model = (extra: Record<string, unknown> = {}) => base({ id: "scorer", name: "Scorer", kind: "model_endpoint", family: "aws:sagemaker-runtime", config: { endpointName: "partner-scorer" }, backing: fake(), connect: { env: [], hostAliases: [] }, ...extra });
    expect(ok(model())).toBe(true);
    expect(ok(model({ config: undefined }))).toBe(false);
    expect(ok(model({ kind: "cloud_api" }))).toBe(false);
    expect(ok(base({ config: { endpointName: "partner-scorer" } }))).toBe(false);
  });
  it("lets a none-backing exclude tests, but not for tests that fake the dependency themselves", () => {
    const none = (backing: Record<string, unknown>) => base({ backing: { kind: "none", ...backing }, connect: { env: [], hostAliases: [] } });
    expect(ok(none({ reason: "not_supported", excludedTests: ["tests/integration/test_search.py::*"] }))).toBe(true);
    expect(ok(none({ reason: "faked_by_tests" }))).toBe(true);
    expect(ok(none({ reason: "faked_by_tests", excludedTests: ["tests/*"] }))).toBe(false);
    expect(ok(none({ reason: "declined", excludedTests: [] }))).toBe(false);
    expect(ok(none({ reason: "declined", excludedTests: ["../outside"] }))).toBe(false);
    expect(ok(none({ reason: "declined", excludedTests: ["/abs/path"] }))).toBe(false);
    expect(ok(none({ reason: "declined", excludedTests: ["a; rm -rf /"] }))).toBe(false);
    expect(ok(none({ reason: "declined", excludedTests: Array.from({ length: 65 }, (_, n) => `t${String(n)}`) }))).toBe(false);
    expect(ok(none({ reason: "bogus" }))).toBe(false);
  });
  it("has nothing to point the code at when nothing backs it", () => {
    expect(ok(base({ backing: { kind: "none", reason: "declined" } }))).toBe(false);
  });
});

describe("connection variables", () => {
  const env = (name: string, template: string) => base({ connect: { env: [{ name, template }], hostAliases: [] } });
  it("refuses a placeholder it does not know, stray braces and unprintable text", () => {
    for (const template of ["{secret}", "{host", "host}", "{{host}}", "{ host }", "a b", "tab\there", "", "x".repeat(257), "é{host}"]) expect(ok(env("X", template)), JSON.stringify(template)).toBe(false);
  });
  it("refuses every shell and quoting character, anywhere", () => {
    for (const character of ["`", "$", ";", "|", "&", "<", ">", '"', "'", "\\"]) {
      for (const template of [`{host}${character}`, `http://{host}/a${character}b`, `${character}{host}`, `http://{host}/?q=${character}{db}`]) {
        expect(dep.connectTemplateProblem(template), JSON.stringify(template)).toBe("shell_character");
        expect(ok(env("X", template)), JSON.stringify(template)).toBe(false);
      }
    }
    expect(dep.connectTemplateProblem("http://{host}/$(id)")).toBe("shell_character");
    expect(dep.connectTemplateProblem("{host};{port}")).toBe("shell_character");
  });
  it("refuses text that looks like a key, anywhere in a template", () => {
    const build = (...parts: string[]) => parts.join("");
    const token = ["Qk7mP2xR9vLw", "4NtY8bZc3HdF", "6gJs1VaUeXoI5"].join("");
    for (const text of [build("sk", "_live_", token.slice(0, 20)), build("sk", "_test_", token.slice(0, 20)), build("AKIA", "ABCDEFGHIJKLMNOP"), build("gh", "p_", token), build("-----", "BEGIN"), token, build("ey", "J", token.slice(0, 16), ".", token.slice(0, 16), ".", token.slice(0, 16))]) {
      for (const template of [`https://{host}/v1/${text}`, `https://{host}/?id=${text}`, `{host}/${text}`]) {
        expect(dep.connectTemplateProblem(template), template.slice(0, 24)).toBe("secret_shaped");
        expect(ok(env("X", template)), template.slice(0, 24)).toBe(false);
      }
    }
  });
  it("refuses a password, token, key or secret query parameter that is not a placeholder", () => {
    for (const template of ["https://{host}/v1?password=abc", "https://{host}/v1?token=abc", "https://{host}/v1?api_key=abc", "https://{host}/v1?apikey=abc", "https://{host}/v1?secret=abc", "https://{host}/v1?Access_Token=abc", "https://{host}/v1?key=", "https://{host}/v1?pwd=abc", "https://{host}/v1?pass=abc", "https://{host}/v1?auth=abc", "https://{host}/v1?sig=abc", "https://{host}/v1?credentials=abc", "https://{host}/v1?secretvalue", "https://{host}/v1?password={password}x", "https://{host}/v1?token=x{password}", "https://{host}/v1?key={}", "{endpoint}?token=abc"]) {
      expect(dep.connectTemplateProblem(template), template).toBe(template.endsWith("{}") ? "placeholder" : "query_secret");
      expect(ok(env("X", template)), template).toBe(false);
    }
    for (const template of ["https://{host}/v1?password={password}", "https://{host}/v1?token={password}", "https://{host}/v1?sslmode=disable", "https://{host}/v1?region={region}", "{endpoint}?api_key={password}"]) {
      expect(dep.connectTemplateProblem(template), template).toBeUndefined();
      expect(ok(env("X", template)), template).toBe(true);
    }
  });
  it("lets the user information be only {user} and {password}", () => {
    for (const template of ["http://{user}:{password}:{password}@{host}", "http://:{password}:x@{host}", "http://evil.com@{host}", "http://{host}@evil.com", "http://a:b:c@{host}", "http://{user}:{user}@{host}", "http://admin:{password}@{host}", "http://{db}@{host}", "http://@@{host}", "http://{user}@x@{host}"]) {
      expect(["userinfo", "password_literal"], template).toContain(dep.connectTemplateProblem(template));
      expect(ok(env("X", template)), template).toBe(false);
    }
    for (const template of ["http://{user}@{host}", "http://{user}:{password}@{host}", "redis://:{password}@{host}", "http://@{host}"]) expect(ok(env("X", template)), template).toBe(true);
  });
  it("lets the host be only {host} or {endpoint}, with an optional {port}", () => {
    for (const template of ["http://evil.com/", "http://{host}.evil.com", "http://{db}:{port}", "http://{host}:8080", "http://{host}:{port}x", "http://", "http:///x", "http://{host}{host}", "http://localhost", "http://127.0.0.1", "HTTP://{host}", "{host}@x", "evil.com", "{host}.evil.com", "{db}.{host}x", "http://{region}.example.com", "x://{port}"]) {
      expect(["host", "userinfo"], template).toContain(dep.connectTemplateProblem(template));
      expect(ok(env("X", template)), template).toBe(false);
    }
    for (const template of ["http://{host}", "http://{endpoint}", "https://{endpoint}:{port}/v1", "postgres://{user}:{password}@{endpoint}:{port}/{db}", "{host}:{port}", "{host},{host}", "{endpoint}/v1", "{region}"]) expect(ok(env("X", template)), template).toBe(true);
  });
  it("refuses a variable name that Rovara or the system owns", () => {
    for (const name of ["AWS_ENDPOINT_URL", "AWS_ACCESS_KEY_ID", "PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "GIT_SSH_COMMAND", "ROVARA_TOKEN", "AGENTX_X", "PYTHONPATH", "DOCKER_HOST", "JAVA_TOOL_OPTIONS"]) {
      expect(ok(env(name, "{host}")), name).toBe(false);
      expect(shared.reservedDependencyEnvName(name.toLowerCase())).toBe(true);
    }
    for (const name of ["DATABASE_URL", "REDIS_URL", "PAYMENTS_API_URL", "DB_PASSWORD"]) expect(ok(env(name, "{host}")), name).toBe(true);
  });
  it("sets a variable once and lists an alias once", () => {
    expect(ok(base({ connect: { env: [{ name: "A", template: "{host}" }, { name: "A", template: "{port}" }], hostAliases: [] } }))).toBe(false);
    expect(ok(base({ connect: { env: [], hostAliases: ["db", "db"] } }))).toBe(false);
  });
  it("keeps the helpers' own names off the network as aliases", () => {
    for (const alias of ["localhost", "dns", "proxy", "sinkhole", "test-account-proxy", "dns-helper", "rovara"]) expect(ok(base({ connect: { env: [], hostAliases: [alias] } })), alias).toBe(false);
    expect(ok(base({ connect: { env: [], hostAliases: ["Postgres"] } }))).toBe(false);
  });
});

describe("the list", () => {
  const many = (count: number, make: (n: number) => Record<string, unknown>) => Array.from({ length: count }, (_, n) => make(n));
  const named = (n: number, over: Record<string, unknown> = {}) => base({ id: `d${String(n)}x`, name: `D ${String(n)}`, connect: { env: [{ name: `URL_${String(n)}`, template: "{host}" }], hostAliases: [`h${String(n)}`] }, ...over });
  it("starts at most 12 in a run; local, project-image and fake each start one, emulated ones share one", () => {
    const local = (n: number) => named(n);
    expect(dep.TestEnvDependenciesSchema.safeParse(many(12, local)).success).toBe(true);
    expect(dep.TestEnvDependenciesSchema.safeParse(many(13, local)).success).toBe(false);
    const aws = (n: number) => base({ id: `aws${String(n)}x`, name: "A", family: "aws:s3", kind: "object_store", backing: { kind: "emulated", catalogId: "local-aws@1", awsServices: ["s3"], region: "us-east-1" }, connect: { env: [], hostAliases: [] } });
    const parsed = (list: Record<string, unknown>[]) => list.map((item) => dep.TestEnvDependencySchema.parse(item));
    expect(dep.testEnvStartedCount(parsed([aws(1), aws(2), aws(3)]))).toBe(1);
    expect(dep.testEnvStartedCount(parsed([named(1), named(2, { backing: fake() }), named(3, { backing: { kind: "project_image", imageId: "i" } })]))).toBe(3);
    expect(dep.testEnvStartedCount(parsed([named(1, { backing: account }), named(2, { backing: account }), named(3, { backing: { kind: "none", reason: "declined" }, connect: { env: [], hostAliases: [] } })]))).toBe(1);
  });
  it("lets the company raise the cap to 16 and no further", () => {
    expect(dep.testEnvDependenciesSchemaFor({ maxStarted: 16 }).safeParse(many(16, named)).success).toBe(true);
    expect(dep.testEnvDependenciesSchemaFor({ maxStarted: 16 }).safeParse(many(17, named)).success).toBe(false);
    expect(dep.testEnvDependenciesSchemaFor({ maxStarted: 17 }).safeParse(many(1, named)).success).toBe(false);
    expect(dep.testEnvDependenciesSchemaFor({ maxStarted: 2 }).safeParse(many(3, named)).success).toBe(false);
  });
});

describe("less-safe fields and risk", () => {
  const list = (...items: Record<string, unknown>[]) => dep.TestEnvDependenciesSchema.parse(items);
  it("returns the fields in their fixed order", () => {
    const changes = dep.testEnvDependencyLessSafeChanges(undefined, list(base({ backing: account, workingBacking: fake({ unmatched: "schema_synth" }) })), { next: { maxStarted: 16 } });
    expect(changes).toEqual(["test_account", "schema_synth", "run_cap_raised"]);
    expect(changes).toEqual([...changes].sort((a, b) => dep.TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS.indexOf(a) - dep.TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS.indexOf(b)));
  });
  it("is medium risk for real software, a fake or the emulator, and high for a test account, project image, substitute image or excluded tests", () => {
    expect(dep.testEnvDependencyApprovalRisk(list(base()))).toBe("medium");
    expect(dep.testEnvDependencyApprovalRisk(list(base({ backing: fake({ unmatched: "schema_synth" }) })))).toBe("medium");
    expect(dep.testEnvDependencyApprovalRisk([])).toBe("medium");
    expect(dep.testEnvDependencyApprovalRisk(list(base({ backing: account })))).toBe("high");
    expect(dep.testEnvDependencyApprovalRisk(list(base({ backing: { kind: "project_image", imageId: "i" } })))).toBe("high");
    expect(dep.testEnvDependencyApprovalRisk(list(base({ backing: { kind: "none", reason: "declined", excludedTests: ["a"] }, connect: { env: [], hostAliases: [] } })))).toBe("high");
    expect(dep.testEnvDependencyApprovalRisk(list(base({ backing: { kind: "none", reason: "declined" }, connect: { env: [], hostAliases: [] } })))).toBe("medium");
    expect(dep.testEnvDependencyApprovalRisk(list(base({ backing: { kind: "local", catalogId: "postgres@16", config: {}, substituteImage: { digest: sha("b"), catalogDigest: sha("c"), approvalRef: "approval:substitute-2026-11-02" } } })))).toBe("high");
    expect(dep.testEnvDependencyApprovalRisk(list(base({ workingBacking: { kind: "project_image", imageId: "i" } })))).toBe("high");
  });
});

describe("reading today's TestEnvService (2.3)", () => {
  const preprod = { endpointArn: "arn:aws:sagemaker:us-west-2:222222222222:endpoint/partner-scorer", roleArn: "arn:aws:iam::222222222222:role/rovara-invoke", region: "us-west-2" };
  const v1 = (over: Record<string, unknown>): TestEnvService => TestEnvServiceSchema.parse({ name: "Partner scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" }, ...over });
  const converted = (service: TestEnvService) => {
    const result = dep.testEnvServiceToDependency(service);
    if (!result.ok) throw new Error(result.reason);
    return result;
  };

  it("turns a pre-prod service into a test-account backing and hands back what moves into the account", () => {
    const result = converted(v1({ mode: "preprod", mock: undefined, preprod }));
    expect(result.dependency.backing).toEqual({ kind: "test_account", accountId: "legacy-partner-scorer" });
    expect(result.dependency.fallback).toBeUndefined();
    expect(result.movedPreprod).toEqual({ ...preprod, accountId: "legacy-partner-scorer" });
  });
  it("turns auto into a test account with a fake fallback", () => {
    const result = converted(v1({ mode: "auto", preprod }));
    expect(result.dependency.backing).toMatchObject({ kind: "test_account" });
    expect(result.dependency.fallback).toEqual({ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail" });
    expect(result.movedPreprod?.endpointArn).toBe(preprod.endpointArn);
  });
  it("turns an http service into an http_api and an AWS API service into a cloud_api", () => {
    expect(converted(v1({ name: "Payments API", kind: "http", match: { host: "api.example-pay.com" } })).dependency).toMatchObject({ kind: "http_api", family: "http:api.example-pay.com" });
    expect(converted(v1({ name: "Orders table", kind: "aws_api", match: { host: "dynamodb.us-west-2.amazonaws.com" } })).dependency).toMatchObject({ kind: "cloud_api", family: "aws:dynamodb" });
    expect(converted(v1({ name: "Global", kind: "aws_api", match: { host: "sts.amazonaws.com" } })).dependency.family).toBe("aws:sts");
    // A SageMaker Runtime host without an endpoint name cannot be a model endpoint, so it is refused, not guessed.
    expect(dep.testEnvServiceToDependency(v1({ name: "Endpoint", kind: "aws_api", match: { host: "runtime.sagemaker.us-east-1.amazonaws.com" } }))).toEqual({ ok: false, reason: "invalid" });
  });
  it("refuses an AWS API service whose host is not an AWS endpoint, and an http service on an address", () => {
    expect(dep.testEnvServiceToDependency(v1({ kind: "aws_api", match: { host: "example.com" } }))).toEqual({ ok: false, reason: "not_an_aws_host" });
    expect(dep.testEnvServiceToDependency(v1({ kind: "aws_api", match: { host: "a.b.c.amazonaws.com" } }))).toEqual({ ok: false, reason: "not_an_aws_host" });
    expect(dep.testEnvServiceToDependency(v1({ kind: "aws_api", match: { host: "intranet-service-host" } }))).toEqual({ ok: false, reason: "not_an_aws_host" });
    expect(dep.testEnvServiceToDependency(v1({ kind: "http", match: { host: "10.0.0.5" } }))).toEqual({ ok: false, reason: "invalid" });
    expect(dep.testEnvServiceToDependency(v1({ kind: "http", match: { host: "localhost" } }))).toEqual({ ok: false, reason: "invalid" });
  });
  it("makes an id from the name and keeps ids unique across a list", () => {
    expect(converted(v1({ name: "9 Weird  Name!!" })).dependency.id).toBe("d-9-weird-name");
    expect(converted(v1({ name: "!!!" })).dependency.id).toMatch(/^dep-[a-f0-9]{8}$/);
    const list = dep.testEnvServicesToDependencies([v1({ name: "Scorer" }), v1({ name: "scorer" }), v1({ name: "SCORER!" })]);
    expect(list.ok && list.dependencies.map((item) => item.id)).toEqual(["scorer", "scorer-2", "scorer-3"]);
  });
  it("converts a whole services list and fails on the first service it cannot read", () => {
    const good = dep.testEnvServicesToDependencies([v1({}), v1({ name: "Payments API", kind: "http", match: { host: "api.example-pay.com" } })]);
    expect(good.ok && good.dependencies.length).toBe(2);
    expect(dep.testEnvServicesToDependencies([v1({}), v1({ name: "Bad one", kind: "aws_api", match: { host: "example.com" } })])).toEqual({ ok: false, reason: "not_an_aws_host", serviceName: "Bad one" });
    expect(dep.testEnvServicesToDependencies([])).toEqual({ ok: true, dependencies: [], movedPreprod: [] });
  });
  it("reads dependencies when an environment has them and converts services when it has those, never both", () => {
    const stored = dep.testEnvServicesToDependencies([v1({})]);
    if (!stored.ok) throw new Error("unreachable");
    expect(dep.readTestEnvDependencies({ services: [], dependencies: stored.dependencies })).toMatchObject({ ok: true });
    expect(dep.readTestEnvDependencies({ services: [v1({})] })).toMatchObject({ ok: true });
    expect(dep.readTestEnvDependencies({ services: [v1({})], dependencies: stored.dependencies })).toMatchObject({ ok: false, reason: "both_shapes" });
    expect(dep.readTestEnvDependencies({ services: [], dependencies: [{ ...stored.dependencies[0], extra: 1 } as never] })).toMatchObject({ ok: false, reason: "invalid" });
  });
});
