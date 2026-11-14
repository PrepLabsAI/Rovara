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
const parse = (value: unknown) => dep.TestEnvDependencySchema.parse(value);

describe("TestEnvDependency", () => {
  it("accepts a real database and round-trips it", () => {
    expect(parse(base())).toEqual(base());
  });
  it("is strict at every level", () => {
    expect(ok(base({ extra: 1 }))).toBe(false);
    expect(ok(base({ backing: { kind: "local", catalogId: "postgres@16", config: {}, extra: 1 } }))).toBe(false);
    expect(ok(base({ connect: { env: [], hostAliases: [], extra: 1 } }))).toBe(false);
  });
  it("carries over names and files from a project's service, never a password", () => {
    expect(ok(base({ backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", initFiles: ["db/init.sql"], extensions: ["pgcrypto"] } } }))).toBe(true);
    expect(ok(base({ backing: { kind: "local", catalogId: "postgres@16", config: { password: "x" } } }))).toBe(false);
    expect(ok(base({ backing: { kind: "local", catalogId: "postgres@16", config: { initFiles: ["../secret.sql"] } } }))).toBe(false);
  });
  it("needs at least one source and one use", () => {
    expect(ok(base({ found: [] }))).toBe(false);
    expect(ok(base({ usedBy: [] }))).toBe(false);
    expect(ok(base({ usedBy: ["unit", "unit"] }))).toBe(false);
    expect(ok(base({ found: ["detector:compose", "model", "person"] }))).toBe(true);
    expect(ok(base({ found: ["detector:not valid"] }))).toBe(false);
  });
  it("bounds the sources, variables, aliases and seeds", () => {
    expect(ok(base({ found: Array.from({ length: 9 }, (_, n) => ({ path: "a.yml", line: n + 1 })) }))).toBe(false);
    expect(ok(base({ connect: { env: Array.from({ length: 17 }, (_, n) => ({ name: `VAR_${String(n)}`, template: "{host}" })), hostAliases: [] } }))).toBe(false);
    expect(ok(base({ connect: { env: [], hostAliases: ["a", "b", "c", "d", "e"] } }))).toBe(false);
    expect(ok(base({ seeds: Array.from({ length: 9 }, () => ({ fixturePath: "db/seed.sql" })) }))).toBe(false);
  });
  it("takes a seed command or a repository file", () => {
    expect(ok(base({ seeds: [{ command: { cwd: "service", executable: "npm", args: ["run", "db:seed"], timeoutSeconds: 60 } }, { fixturePath: "db/seed.sql" }] }))).toBe(true);
    expect(ok(base({ seeds: [{ fixturePath: "/etc/passwd" }] }))).toBe(false);
  });
});

describe("families and identifiers", () => {
  it.each(["postgres", "redis", "kafka", "aws:s3", "aws:sagemaker-runtime", "http:api.example-pay.com"])("accepts the family %s", (family) => {
    expect(dep.FamilyIdSchema.safeParse(family).success).toBe(true);
  });
  it.each(["", "Postgres", "aws:", "aws:S3", "http:localhost", "http:10.0.0.1", "http:*.example.com", "http:example.com/path", "http:Example.com", "http:a.b:80", "x y"])("refuses the family %j", (family) => {
    expect(dep.FamilyIdSchema.safeParse(family).success).toBe(false);
  });
  it("refuses an http family whose host can be read as an address, in any spelling", () => {
    for (const host of ["127.1", "127.0.1", "10.1", "0x7f.0.0.1", "0177.0.0.1", "169.254.43518", "127.0.0.1", "10.0.0.1", "1.1", "0x7f.1", "a.1", "a.b.0x1", "localhost", "0.0.0.0", "2130706433"]) {
      expect(dep.FamilyIdSchema.safeParse(`http:${host}`).success, host).toBe(false);
      expect(ok(base({ id: "api", name: "API", kind: "http_api", family: `http:${host}`, backing: { kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail" }, connect: { env: [], hostAliases: [] } })), host).toBe(false);
    }
    for (const host of ["api.example-pay.com", "a.io", "1password.example.com"]) expect(dep.FamilyIdSchema.safeParse(`http:${host}`).success, host).toBe(true);
  });
  it("refuses a catalog id that is not name@version", () => {
    expect(dep.CatalogIdSchema.safeParse("postgres@16").success).toBe(true);
    for (const bad of ["postgres", "Postgres@16", "postgres@", "@16", "postgres@16 ", "postgres@1/6"]) expect(dep.CatalogIdSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe("backings", () => {
  it("accepts every kind with its own fields", () => {
    expect(ok(base({ backing: { kind: "project_image", imageId: "scorer-image" } }))).toBe(true);
    expect(ok(base({ id: "aws-s3", family: "aws:s3", kind: "object_store", backing: { kind: "emulated", catalogId: "local-aws@1", awsServices: ["s3", "sqs"], region: "us-east-1", resources: { provider: "cloudformation", path: "infra/stack.yml" } }, connect: { env: [], hostAliases: ["aws"] } }))).toBe(true);
    expect(ok(base({ backing: account }))).toBe(true);
    expect(ok(base({ backing: fake() }))).toBe(true);
    expect(ok(base({ backing: { kind: "none", reason: "declined" }, connect: { env: [], hostAliases: [] } }))).toBe(true);
  });
  it("refuses a backing with another kind's field", () => {
    expect(ok(base({ backing: { kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", accountId: "x" } }))).toBe(false);
    expect(ok(base({ backing: { kind: "test_account", accountId: "x", fixtureSetRef: sha("a") } }))).toBe(false);
    expect(ok(base({ backing: { kind: "mystery" } }))).toBe(false);
  });
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

describe("rules of 2.2", () => {
  it("allows a fallback only of a fake or none", () => {
    expect(ok(base({ backing: account, fallback: fake() }))).toBe(true);
    expect(ok(base({ backing: account, fallback: { kind: "none", reason: "declined" } }))).toBe(true);
    for (const fallback of [{ kind: "local", catalogId: "postgres@16", config: {} }, account, { kind: "project_image", imageId: "x" }, { kind: "emulated", catalogId: "local-aws@1", awsServices: ["s3"], region: "us-east-1" }]) {
      expect(ok(base({ backing: fake(), fallback })), String(fallback.kind)).toBe(false);
    }
  });
  it("never gives the working sandbox a test account", () => {
    expect(ok(base({ backing: account, workingBacking: fake() }))).toBe(true);
    expect(ok(base({ backing: account, workingBacking: account }))).toBe(false);
    expect(ok(base({ workingBacking: { kind: "local", catalogId: "postgres@16", config: {} } }))).toBe(true);
  });
  it("lets only a helper that Rovara starts be reset between checks", () => {
    expect(ok(base({ reset: "between_checks" }))).toBe(true);
    expect(ok(base({ backing: fake(), reset: "between_checks" }))).toBe(true);
    expect(ok(base({ backing: account, reset: "between_checks" }))).toBe(false);
    expect(ok(base({ backing: { kind: "none", reason: "declined" }, connect: { env: [], hostAliases: [] }, reset: "between_checks" }))).toBe(false);
  });
});

describe("a company-approved substitute image", () => {
  const substitute = (extra: Record<string, unknown> = {}) => base({ backing: { kind: "local", catalogId: "postgres@16", config: {}, substituteImage: { digest: sha("b"), catalogDigest: sha("c"), approvalRef: "approval:substitute-2026-11-02", ...extra } } });
  it("is allowed with an approval reference and a digest that differs from the catalog's", () => {
    expect(ok(substitute())).toBe(true);
  });
  it("is refused without the approval reference", () => {
    expect(ok(base({ backing: { kind: "local", catalogId: "postgres@16", config: {}, substituteImage: { digest: sha("b"), catalogDigest: sha("c") } } }))).toBe(false);
    expect(ok(substitute({ approvalRef: "" }))).toBe(false);
    expect(ok(substitute({ approvalRef: "short" }))).toBe(false);
    expect(ok(substitute({ approvalRef: "has space in it" }))).toBe(false);
  });
  it("is refused when its digest is the catalog's own, or malformed", () => {
    expect(ok(substitute({ digest: sha("c") }))).toBe(false);
    expect(ok(substitute({ digest: "sha256:abc" }))).toBe(false);
    expect(ok(substitute({ digest: "B".repeat(64) }))).toBe(false);
  });
  it("belongs to a local backing only", () => {
    expect(ok(base({ backing: fake({ substituteImage: { digest: sha("b"), catalogDigest: sha("c"), approvalRef: "approval:substitute-2026-11-02" } }) }))).toBe(false);
  });
});

describe("connection variables", () => {
  const env = (name: string, template: string) => base({ connect: { env: [{ name, template }], hostAliases: [] } });
  it("takes a template made of the run's own placeholders", () => {
    for (const template of ["postgres://{user}:{password}@{host}:{port}/{db}", "redis://:{password}@{host}:{port}", "{host}", "http://{host}:{port}", "{region}", "{endpoint}/v1", "amqp://{user}:{password}@{host}"]) expect(ok(env("X", template)), template).toBe(true);
  });
  it("refuses a placeholder it does not know, stray braces and unprintable text", () => {
    for (const template of ["{secret}", "{host", "host}", "{{host}}", "{ host }", "a b", "tab\there", "", "x".repeat(257), "é{host}"]) expect(ok(env("X", template)), JSON.stringify(template)).toBe(false);
  });
  it("lets a password be only the run's {password}, never a literal", () => {
    expect(ok(env("X", "postgres://app:hunter2@{host}:{port}/{db}"))).toBe(false);
    expect(ok(env("X", "postgres://app:{password}x@{host}"))).toBe(false);
    expect(ok(env("X", "postgres://app:@{host}"))).toBe(false);
    expect(dep.connectTemplateProblem("postgres://app:hunter2@{host}")).toBe("password_literal");
    expect(dep.connectTemplateProblem("{password}")).toBeUndefined();
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
  it("refuses the names of the interpreters, package managers, TLS, shell, cloud and model-provider variables, each by name and by prefix", () => {
    const prefixes = ["PYTHON", "NPM_CONFIG_", "PIP_", "UV_", "YARN_", "GO", "CARGO_", "XDG_", "SSL", "OPENSSL_", "GLIBC_", "GCONV_", "BASH", "KUBE", "GOOGLE_", "AZURE_", "ANTHROPIC_", "OPENAI_", "AGENTX_", "ROVARA_", "AWS_", "GIT_", "LD_", "DYLD_", "PI_", "DOCKER_"];
    for (const prefix of prefixes) for (const name of [`${prefix}X`, `${prefix}SETTING_1`]) expect(ok(env(name, "{host}")), name).toBe(false);
    const names = ["NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE", "HOSTALIASES", "TMPDIR", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "FTP_PROXY", "MAVEN_OPTS", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "RUBYOPT", "PERL5OPT", "PERL5LIB", "BASH_ENV", "PYTHONPATH", "NODE_OPTIONS", "CLASSPATH"];
    for (const name of names) {
      expect(shared.reservedDependencyEnvName(name), name).toBe(true);
      if (/^[A-Z][A-Z0-9_]{0,63}$/u.test(name)) expect(ok(env(name, "{host}")), name).toBe(false);
    }
    // `_JAVA_OPTIONS` is not an acceptable variable name here at all, but it is still reserved for every other place that asks.
    expect(ok(env("_JAVA_OPTIONS", "{host}"))).toBe(false);
  });
  it("refuses a lower-case, empty or oversized variable name", () => {
    for (const name of ["database_url", "", "1X", "A".repeat(65), "A-B"]) expect(ok(env(name, "{host}")), name).toBe(false);
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
  it("holds at most 24 dependencies", () => {
    expect(dep.TestEnvDependenciesSchema.safeParse(many(24, (n) => named(n, { backing: n < 12 ? { kind: "local", catalogId: "postgres@16", config: {} } : { kind: "none", reason: "declined" }, connect: { env: [], hostAliases: [] } }))).success).toBe(true);
    expect(dep.TestEnvDependenciesSchema.safeParse(many(25, (n) => named(n, { backing: { kind: "none", reason: "declined" }, connect: { env: [], hostAliases: [] } }))).success).toBe(false);
  });
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
  it("keeps ids, variables and aliases unique across dependencies", () => {
    expect(dep.TestEnvDependenciesSchema.safeParse([named(1), named(2, { id: "d1x" })]).success).toBe(false);
    expect(dep.TestEnvDependenciesSchema.safeParse([named(1), named(2, { connect: { env: [{ name: "URL_1", template: "{host}" }], hostAliases: [] } })]).success).toBe(false);
    expect(dep.TestEnvDependenciesSchema.safeParse([named(1), named(2, { connect: { env: [], hostAliases: ["h1"] } })]).success).toBe(false);
    expect(dep.TestEnvDependenciesSchema.safeParse([named(1), named(2)]).success).toBe(true);
  });
});

describe("less-safe fields and risk", () => {
  const list = (...items: Record<string, unknown>[]) => dep.TestEnvDependenciesSchema.parse(items);
  const second = (over: Record<string, unknown>) => base({ id: "other", name: "Other", connect: { env: [], hostAliases: [] }, ...over });
  it("names every less-safe use in the first proposal", () => {
    expect(dep.testEnvDependencyLessSafeChanges(undefined, list(base()))).toEqual([]);
    expect(dep.testEnvDependencyLessSafeChanges(undefined, list(base({ backing: account })))).toEqual(["test_account"]);
    expect(dep.testEnvDependencyLessSafeChanges(undefined, list(base({ backing: { kind: "project_image", imageId: "i" } })))).toEqual(["project_image"]);
    expect(dep.testEnvDependencyLessSafeChanges(undefined, list(base({ backing: fake({ unmatched: "schema_synth" }) })))).toEqual(["schema_synth"]);
    expect(dep.testEnvDependencyLessSafeChanges(undefined, list(base({ backing: { kind: "none", reason: "declined", excludedTests: ["a/*"] }, connect: { env: [], hostAliases: [] } })))).toEqual(["none_excluded_tests"]);
    expect(dep.testEnvDependencyLessSafeChanges(undefined, list(base({ backing: { kind: "local", catalogId: "postgres@16", config: {}, substituteImage: { digest: sha("b"), catalogDigest: sha("c"), approvalRef: "approval:substitute-2026-11-02" } } })))).toEqual(["substitute_image"]);
    expect(dep.testEnvDependencyLessSafeChanges(undefined, list(base({ backing: account, fallback: fake({ unmatched: "schema_synth" }), workingBacking: { kind: "project_image", imageId: "i" } })))).toEqual(["test_account", "project_image", "schema_synth"]);
  });
  it("counts a fake that makes up answers in the working slot and in the fallback", () => {
    expect(dep.testEnvDependencyLessSafeChanges(undefined, list(base({ workingBacking: fake({ unmatched: "schema_synth" }) })))).toEqual(["schema_synth"]);
    expect(dep.testEnvDependencyLessSafeChanges(undefined, list(base({ backing: account, fallback: { kind: "none", reason: "declined", excludedTests: ["x"] } })))).toEqual(["test_account", "none_excluded_tests"]);
  });
  it("does not call an unchanged use a change, but does call a moved or added one", () => {
    const before = list(base({ backing: account }));
    expect(dep.testEnvDependencyLessSafeChanges(before, before)).toEqual([]);
    expect(dep.testEnvDependencyLessSafeChanges(before, list(base({ backing: { kind: "test_account", accountId: "other-account" } })))).toEqual(["test_account"]);
    expect(dep.testEnvDependencyLessSafeChanges(before, list(base({ backing: account }), second({ backing: { kind: "test_account", accountId: "another" } })))).toEqual(["test_account"]);
    expect(dep.testEnvDependencyLessSafeChanges(before, list(base()))).toEqual([]);
  });
  it("calls widening the excluded tests a change and narrowing them not", () => {
    const none = (...excludedTests: string[]) => list(base({ backing: { kind: "none", reason: "declined", excludedTests }, connect: { env: [], hostAliases: [] } }));
    expect(dep.testEnvDependencyLessSafeChanges(none("a/*"), none("a/*", "b/*"))).toEqual(["none_excluded_tests"]);
    expect(dep.testEnvDependencyLessSafeChanges(none("a/*", "b/*"), none("a/*"))).toEqual([]);
  });
  it("calls a substitute image whose digest or approval changed a change", () => {
    const sub = (digest: string, approvalRef: string) => list(base({ backing: { kind: "local", catalogId: "postgres@16", config: {}, substituteImage: { digest, catalogDigest: sha("c"), approvalRef } } }));
    expect(dep.testEnvDependencyLessSafeChanges(sub(sha("b"), "approval:aaaaaa"), sub(sha("b"), "approval:aaaaaa"))).toEqual([]);
    expect(dep.testEnvDependencyLessSafeChanges(sub(sha("b"), "approval:aaaaaa"), sub(sha("d"), "approval:aaaaaa"))).toEqual(["substitute_image"]);
    expect(dep.testEnvDependencyLessSafeChanges(sub(sha("b"), "approval:aaaaaa"), sub(sha("b"), "approval:bbbbbb"))).toEqual(["substitute_image"]);
  });
  it("calls raising the run cap a change, and lowering or keeping it not", () => {
    const one = list(base());
    expect(dep.testEnvDependencyLessSafeChanges(one, one, { next: { maxStarted: 16 } })).toEqual(["run_cap_raised"]);
    expect(dep.testEnvDependencyLessSafeChanges(one, one, { previous: { maxStarted: 14 }, next: { maxStarted: 16 } })).toEqual(["run_cap_raised"]);
    expect(dep.testEnvDependencyLessSafeChanges(one, one, { previous: { maxStarted: 16 }, next: { maxStarted: 16 } })).toEqual([]);
    expect(dep.testEnvDependencyLessSafeChanges(one, one, { previous: { maxStarted: 16 }, next: { maxStarted: 8 } })).toEqual([]);
    expect(dep.testEnvDependencyLessSafeChanges(one, one, { next: { maxStarted: 12 } })).toEqual([]);
  });
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

  it("turns a mocked SageMaker endpoint into a model endpoint with a fake backing", () => {
    const { dependency, movedPreprod } = converted(v1({}));
    expect(dependency).toMatchObject({ id: "partner-scorer", kind: "model_endpoint", family: "aws:sagemaker-runtime", config: { endpointName: "partner-scorer" }, backing: { kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail" }, reset: "fresh_per_round" });
    expect(dependency.fallback).toBeUndefined();
    expect(movedPreprod).toBeUndefined();
    expect(ok(dependency)).toBe(true);
  });
  it("keeps schema_synth when the v1 mock had it", () => {
    expect(converted(v1({ mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "schema_synth" } })).dependency.backing).toMatchObject({ kind: "fake", unmatched: "schema_synth" });
  });
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
