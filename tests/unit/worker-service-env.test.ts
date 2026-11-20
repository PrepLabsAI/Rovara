// TS15: the Rovara env channel (test-services.md 4.0.4, 4.0.5). The connection variables, the AWS fake credentials, the per-service endpoints and the sinkhole endpoints that both sandboxes get through a Rovara-owned channel (an env file
// on a tmpfs, passed with --env-file and removed at once), the redactor for the run's secrets, and the setup agent's exact-value exemption. The guards stay: project settings still refuse AWS_*, the end-to-end guard still trips if the
// worker's own environment holds them, and the worker's environment is never touched.
import { mkdtemp, mkdir, rm, stat, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectCommandEnvProblems } from "../../packages/contracts/src/project-node.js";
import { assertE2EEnvironmentCannotRedirect } from "../../packages/model-runtime/src/e2e-environment-guard.js";
import { AWS_FAKE_ACCESS_KEY_ID, AWS_FAKE_SECRET_ACCESS_KEY, SERVICE_ENV_EXEMPT_VALUES, ServiceEnvError, awsEndpointVariableName, buildServiceEnvironment, createRunDirectoryFiles, createServiceRedactor, helperSecretValues, withServiceEnvFile, type ServiceEnvInput } from "../../packages/worker/src/service-env.js";
import { credentialShapedVariables } from "../../packages/worker/src/setup-agent.js";
import type { HelperFiles } from "../../packages/worker/src/service-helpers.js";

const PASSWORD = ["pw", "Zk3Lm9Qx7TbW"].join("");

function input(change: Partial<ServiceEnvInput> = {}): ServiceEnvInput {
  return {
    sandbox: "working",
    sinkholeUrl: "http://sinkhole",
    dependencies: [{
      id: "postgres", host: "postgres", port: 5432, credentials: { user: "rovara", password: PASSWORD, database: "app" },
      connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }, { name: "PGHOST", template: "{host}" }], hostAliases: ["postgres"] },
    }],
    ...change,
  };
}
const asObject = (entries: ReadonlyArray<readonly [string, string]>): Record<string, string> => Object.fromEntries(entries);

describe("connection variables", () => {
  it("a placeholder with no value, a template the contract refuses, or a hostile credential is refused and nothing is returned", () => {
    const base = input().dependencies[0]!;
    const cases: Array<Partial<ServiceEnvInput>> = [
      { dependencies: [{ ...base, credentials: { user: "rovara", database: "app" } }] },
      { dependencies: [{ ...base, credentials: { user: "rovara\nX=1", password: PASSWORD, database: "app" } }] },
      { dependencies: [{ ...base, credentials: { user: "rovara", password: `${PASSWORD}\nAWS_X=1`, database: "app" } }] },
      { dependencies: [{ ...base, connect: { env: [{ name: "DATABASE_URL", template: "postgres://rovara:literalpass@{host}" }], hostAliases: [] } }] },
      { dependencies: [{ ...base, connect: { env: [{ name: "DATABASE_URL", template: "$(id)" }], hostAliases: [] } }] },
      { dependencies: [{ ...base, host: "post gres" }] },
      { dependencies: [{ ...base, host: "Post_gres" }] },
      { dependencies: [{ ...base, credentials: { user: "Rovara", password: PASSWORD, database: "app" } }] },
      { dependencies: [{ ...base, credentials: { user: "rovara", password: "short", database: "app" } }] },
      { dependencies: [{ ...base, credentials: { user: "rovara", password: PASSWORD, database: "app;x" } }] },
      { dependencies: [base, { ...base, connect: { env: [{ name: "OTHER_URL", template: "{host}" }], hostAliases: [] } }] },
      { dependencies: [{ ...base, host: "postgres\nX=1" }] },
      { dependencies: [{ ...base, port: 70_000 }] },
      { dependencies: [{ ...base, region: "us_west_2", connect: { env: [{ name: "R", template: "{region}" }], hostAliases: [] } }] },
    ];
    for (const [index, change] of cases.entries()) expect(() => buildServiceEnvironment(input(change)), `case ${String(index)}`).toThrow(ServiceEnvError);
  });
  it("a dependency cannot set a name Rovara or the system owns, or the same name twice", () => {
    const base = input().dependencies[0]!;
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_ENDPOINT_URL", "PATH", "NODE_OPTIONS", "ROVARA_X", "LD_PRELOAD", "HTTPS_PROXY", "aws_region", "A B"]) {
      expect(() => buildServiceEnvironment(input({ dependencies: [{ ...base, connect: { env: [{ name, template: "{host}" }], hostAliases: [] } }] })), name).toThrow(ServiceEnvError);
    }
    const twice = [{ ...base, id: "a-one", connect: { env: [{ name: "DB_HOST", template: "{host}" }], hostAliases: [] } }, { ...base, id: "b-two", connect: { env: [{ name: "DB_HOST", template: "{host}" }], hostAliases: [] } }];
    expect(() => buildServiceEnvironment(input({ dependencies: twice }))).toThrow(ServiceEnvError);
  });
});

describe("AWS: endpoints, fake credentials and the sinkhole (4.0.5)", () => {
  const aws = { alias: "aws", port: 4566, region: "us-west-2", emulatedServices: ["s3", "dynamodb", "secretsmanager", "sagemaker-runtime", "events"] };
  it("working sandbox: an endpoint per PLANNED service at the emulator (no variable for the others: they reach it through the global endpoint), fake credentials, and the global endpoint at the emulator", () => {
    const env = asObject(buildServiceEnvironment(input({ aws })).entries);
    expect(env).toMatchObject({
      AWS_ENDPOINT_URL_S3: "http://aws:4566", AWS_ENDPOINT_URL_DYNAMODB: "http://aws:4566", AWS_ENDPOINT_URL_SECRETS_MANAGER: "http://aws:4566", AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME: "http://aws:4566", AWS_ENDPOINT_URL_EVENTBRIDGE: "http://aws:4566",
      AWS_ENDPOINT_URL: "http://aws:4566",
      AWS_ACCESS_KEY_ID: AWS_FAKE_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: AWS_FAKE_SECRET_ACCESS_KEY,
      AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "us-west-2", AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    });
    expect(env).not.toHaveProperty("AWS_SESSION_TOKEN");
    expect(env).not.toHaveProperty("AWS_PROFILE");
    // Only the planned services get a variable of their own (not the table's 436): five here, the global endpoint, and the credentials and region.
    expect(Object.keys(env).filter((name) => name.startsWith("AWS_ENDPOINT_URL_"))).toHaveLength(5);
    expect(env).not.toHaveProperty("AWS_ENDPOINT_URL_SQS");
  });
  it("points every endpoint variable the repository's own settings set at the emulator too, once, and refuses a name that is not one", () => {
    const env = asObject(buildServiceEnvironment(input({ aws: { ...aws, repoEndpointNames: ["AWS_ENDPOINT_URL_SNS", "AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL_NOT_A_SERVICE"] } })).entries);
    expect(env).toMatchObject({ AWS_ENDPOINT_URL_SNS: "http://aws:4566", AWS_ENDPOINT_URL_NOT_A_SERVICE: "http://aws:4566", AWS_ENDPOINT_URL_S3: "http://aws:4566" });
    expect(Object.keys(env).filter((name) => name.startsWith("AWS_ENDPOINT_URL_"))).toHaveLength(7);
    for (const name of ["AWS_ENDPOINT_URL", "AWS_REGION", "PATH", "AWS_ENDPOINT_URL_s3", "AWS_ENDPOINT_URL_X"]) expect(() => buildServiceEnvironment(input({ aws: { ...aws, repoEndpointNames: [name] } })), name).toThrow(ServiceEnvError);
  });
  it("an endpoint variable name is the SDK's service id upper-cased; a service the table does not know is refused", () => {
    expect(awsEndpointVariableName("stepfunctions")).toBe("AWS_ENDPOINT_URL_SFN");
    expect(awsEndpointVariableName("sfn")).toBe("AWS_ENDPOINT_URL_SFN");
    expect(awsEndpointVariableName("apigatewayv2")).toBe("AWS_ENDPOINT_URL_APIGATEWAYV2");
    expect(awsEndpointVariableName("api-gateway")).toBe("AWS_ENDPOINT_URL_API_GATEWAY");
    expect(awsEndpointVariableName("ec2")).toBe("AWS_ENDPOINT_URL_EC2");
    expect(awsEndpointVariableName("logs")).toBe("AWS_ENDPOINT_URL_CLOUDWATCH_LOGS");
    expect(awsEndpointVariableName("cognito-idp")).toBe("AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER");
    expect(() => awsEndpointVariableName("nonsense")).toThrow(ServiceEnvError);
    expect(() => awsEndpointVariableName("constructor")).toThrow(ServiceEnvError);
    expect(() => awsEndpointVariableName("__proto__")).toThrow(ServiceEnvError);
    expect(() => awsEndpointVariableName("s3 --x")).toThrow(ServiceEnvError);
    expect(() => buildServiceEnvironment(input({ aws: { ...aws, emulatedServices: ["nonsense"] } }))).toThrow(ServiceEnvError);
  });
  it("a service is planned once (a legacy spelling and its key are one service); the emulator's address and the region are checked", () => {
    expect(() => buildServiceEnvironment(input({ aws: { ...aws, emulatedServices: ["s3", "s3"] } }))).toThrow(ServiceEnvError);
    expect(() => buildServiceEnvironment(input({ aws: { ...aws, emulatedServices: ["secretsmanager", "secrets-manager"] } }))).toThrow(ServiceEnvError);
    expect(() => buildServiceEnvironment(input({ aws: { ...aws, alias: "aws --x" } }))).toThrow(ServiceEnvError);
    expect(() => buildServiceEnvironment(input({ aws: { ...aws, alias: "Aws_x" } }))).toThrow(ServiceEnvError);
    expect(() => buildServiceEnvironment(input({ aws: { ...aws, region: "us_west_2" } }))).toThrow(ServiceEnvError);
    expect(() => buildServiceEnvironment(input({ aws: { ...aws, region: "us-west-2\nX=1" } }))).toThrow(ServiceEnvError);
    expect(() => buildServiceEnvironment(input({ aws: { ...aws, port: 0 } }))).toThrow(ServiceEnvError);
    expect(() => buildServiceEnvironment(input({ sinkholeUrl: "http://sink hole" }))).toThrow(ServiceEnvError);
    expect(() => buildServiceEnvironment(input({ aws, sinkholeUrl: "https://evil.example.com" }))).toThrow(ServiceEnvError);
  });
});

describe("the env file (a tmpfs, removed at once)", () => {
  function fakeFiles() {
    const written: Array<{ name: string; content: string; mode: number }> = [];
    const removed: string[] = [];
    const files: HelperFiles = {
      write(name, content, mode) { written.push({ name, content, mode }); return Promise.resolve(`/run/rovara-test/${name}`); },
      remove(name) { removed.push(name); return Promise.resolve(); },
    };
    return { files, written, removed };
  }
  it("a hostile file name or a value with a line break is refused before anything is written", async () => {
    const f = fakeFiles();
    const env = buildServiceEnvironment(input());
    for (const name of ["../x", "a b", "", "a/b", "x".repeat(100)]) await expect(withServiceEnvFile(f.files, name, env, (a) => Promise.resolve(a)), name).rejects.toBeInstanceOf(ServiceEnvError);
    await expect(withServiceEnvFile(f.files, "ok", { entries: [["A", "x\nB=1"]], secretValues: [] }, (a) => Promise.resolve(a))).rejects.toBeInstanceOf(ServiceEnvError);
    await expect(withServiceEnvFile(f.files, "ok", { entries: [["a b", "x"]], secretValues: [] }, (a) => Promise.resolve(a))).rejects.toBeInstanceOf(ServiceEnvError);
    expect(f.written).toEqual([]);
  });
});

describe("the run's directory (L4: mode 0700 or 0710, whatever the umask)", () => {
  const made: string[] = [];
  afterEach(async () => { for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true }); });
  async function parent(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "rovara-env-test-")); made.push(dir); return dir; }
  const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

  it("any other mode, a relative parent or a hostile name is refused before anything is created", async () => {
    const base = await parent();
    for (const mode of [0o755, 0o750, 0o777, 0o701, 0o770, 0o000, 0o600]) await expect(createRunDirectoryFiles(base, "run-m", mode), String(mode)).rejects.toBeInstanceOf(ServiceEnvError);
    await expect(createRunDirectoryFiles("relative/dir", "run-r")).rejects.toBeInstanceOf(ServiceEnvError);
    // A relative path that exists is refused too: it would depend on the process's working directory.
    await expect(createRunDirectoryFiles(relative(process.cwd(), base), "run-rel")).rejects.toBeInstanceOf(ServiceEnvError);
    await expect(stat(join(base, "run-rel"))).rejects.toThrow();
    for (const name of ["../x", "a/b", "", "a b"]) await expect(createRunDirectoryFiles(base, name), name).rejects.toBeInstanceOf(ServiceEnvError);
    await expect(stat(join(base, "run-m"))).rejects.toThrow();
  });
  it("an existing directory or a link at the path is never reused", async () => {
    const base = await parent();
    await mkdir(join(base, "taken"), { mode: 0o755 });
    await expect(createRunDirectoryFiles(base, "taken")).rejects.toBeInstanceOf(ServiceEnvError);
    await symlink(base, join(base, "link"));
    await expect(createRunDirectoryFiles(base, "link")).rejects.toBeInstanceOf(ServiceEnvError);
    expect(await modeOf(join(base, "taken"))).toBe(0o755);
  });
  it("files are written new (never over an existing file or a link), with the mode asked, and removed idempotently", async () => {
    const base = await parent();
    const dir = await createRunDirectoryFiles(base, "run-f");
    const path = await dir.write("db.env", "A=1\n", 0o600);
    expect(path).toBe(join(dir.directory, "db.env"));
    expect(await readFile(path, "utf8")).toBe("A=1\n");
    await expect(dir.write("db.env", "B=2\n", 0o600)).rejects.toBeInstanceOf(ServiceEnvError);
    const outside = join(base, "outside");
    await writeFile(outside, "keep");
    await symlink(outside, join(dir.directory, "evil.env"));
    await expect(dir.write("evil.env", "B=2\n", 0o600)).rejects.toBeInstanceOf(ServiceEnvError);
    expect(await readFile(outside, "utf8")).toBe("keep");
    for (const name of ["../x", "a/b", "", "A.ENV"]) await expect(dir.write(name, "x", 0o600), name).rejects.toBeInstanceOf(ServiceEnvError);
    await expect(dir.write("ok.env", "x", 0o1777)).rejects.toBeInstanceOf(ServiceEnvError);
    await dir.remove("db.env");
    await dir.remove("db.env");
    await expect(stat(path)).rejects.toThrow();
    await expect(dir.remove("../outside")).rejects.toBeInstanceOf(ServiceEnvError);
  });
});

describe("the worker's own environment is never touched", () => {
  it("the end-to-end guard still trips if the worker's own environment holds them", () => {
    const names = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"];
    for (const name of names) expect(() => assertE2EEnvironmentCannotRedirect({ [name]: AWS_FAKE_ACCESS_KEY_ID }), name).toThrow();
    expect(() => assertE2EEnvironmentCannotRedirect({})).not.toThrow();
  });
  it("project settings still refuse AWS_* (the channel is the only way to set them)", () => {
    expect(projectCommandEnvProblems({ AWS_ACCESS_KEY_ID: AWS_FAKE_ACCESS_KEY_ID }).length).toBeGreaterThan(0);
    expect(projectCommandEnvProblems({ AWS_ENDPOINT_URL_S3: "http://aws:4566" }).length).toBeGreaterThan(0);
    expect(projectCommandEnvProblems({ AWS_REGION: "us-east-1" }).length).toBeGreaterThan(0);
  });
});

describe("the redactor", () => {
  it("replaces the registered values in text, in every spelling, and finds them in bytes", () => {
    const redactor = createServiceRedactor([PASSWORD, AWS_FAKE_SECRET_ACCESS_KEY]);
    const url = `postgres://rovara:${encodeURIComponent(PASSWORD)}@postgres/app`;
    const base64 = Buffer.from(PASSWORD).toString("base64");
    const hex = Buffer.from(PASSWORD).toString("hex");
    for (const text of [`password is ${PASSWORD}`, url, `{"p":"${PASSWORD}"}`, `secret=${AWS_FAKE_SECRET_ACCESS_KEY}`, `Authorization: Basic ${base64}`, `h=${hex}`]) {
      const out = redactor.text(text);
      for (const form of [PASSWORD, AWS_FAKE_SECRET_ACCESS_KEY, base64, hex]) expect(out, text).not.toContain(form);
    }
    expect(redactor.contains(Buffer.from(`x ${base64} y`))).toBe(true);
    expect(redactor.contains(Buffer.from(`xx ${PASSWORD} yy`))).toBe(true);
    expect(redactor.contains(Buffer.from("nothing here"))).toBe(false);
    expect(redactor.text("plain words")).toBe("plain words");
  });
});

describe("H1: the emulator's secrets are registered with the redactor and never become variables", () => {
  const presign = ["pw", "Qq8Rr2Vv5NnC"].join("");
  const control = ["ct", "Vb4Nq8Wz2Kd7"].join("");
  it("the redactor made from them hides both, and neverValues refuses an environment that would carry either", () => {
    const secrets = helperSecretValues([{ credentials: { password: presign, controlToken: control } }]);
    const redactor = createServiceRedactor(secrets);
    expect(redactor.text(`a ${presign} b ${control}`)).toBe("a <redacted> b <redacted>");
    expect(() => buildServiceEnvironment(input({ neverValues: secrets }))).not.toThrow();
    const leaking = input({ neverValues: secrets, dependencies: [{ id: "payments", host: "fake-payments", port: 8080, credentials: {}, connect: { env: [{ name: "PAYMENTS_TOKEN", template: control }], hostAliases: ["fake-payments"] } }] });
    expect(() => buildServiceEnvironment(leaking)).toThrow(ServiceEnvError);
    const embedded = input({ neverValues: secrets, dependencies: [{ id: "payments", host: "fake-payments", port: 8080, credentials: {}, connect: { env: [{ name: "PAYMENTS_URL", template: `{endpoint}/${presign}` }], hostAliases: ["fake-payments"] } }] });
    expect(() => buildServiceEnvironment(embedded)).toThrow(ServiceEnvError);
  });
});

describe("the setup agent's exact-value exemption (4.0.5)", () => {
  it("with it, only the exact fake values Rovara injects pass, by value and not by name", () => {
    const exempt = new Set(SERVICE_ENV_EXEMPT_VALUES);
    expect(credentialShapedVariables({ AWS_ACCESS_KEY_ID: AWS_FAKE_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: AWS_FAKE_SECRET_ACCESS_KEY }, exempt)).toEqual([]);
    // Another AWS value is still a secret.
    expect(credentialShapedVariables({ AWS_ACCESS_KEY_ID: "ROVARATESTKEY2", AWS_SECRET_ACCESS_KEY: "rovaratestsecretx", AWS_SESSION_TOKEN: "sometoken" }, exempt)).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]);
    // The exemption is the value, so the real key shape under the fake's name is still found.
    expect(credentialShapedVariables({ AWS_ACCESS_KEY_ID: ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("") }, exempt)).toEqual(["AWS_ACCESS_KEY_ID"]);
  });
});
