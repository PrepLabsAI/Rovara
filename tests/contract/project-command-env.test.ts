import { ProjectCommandSchema, ProjectDefinitionSchema, StoredProjectDefinitionSchema } from "../../packages/contracts/src/project.js";
import { describe, expect, it } from "vitest";

// #54 (first slice): a project command may set environment variables for itself.
const command = { cwd: "repo/payments-api", executable: "npm", args: ["ci"], timeoutSeconds: 600 };
const project = {
  name: "payments",
  revision: 1,
  repositories: [{
    name: "payments-api",
    url: "https://github.com/example/payments-api.git",
    path: "repo/payments-api",
    defaultBranch: "main",
    credentialRef: "github-agentx-sdlc",
  }],
  setup: [command],
  readiness: [{ ...command, args: ["test"] }],
  orchestratorInstructions: "Delegate all code changes to the remote worker.",
};

/** Everything a caller could show from a failed parse: messages, nested issues and the error text. */
function shown(result: { success: false; error: { issues: unknown[]; message: string } }): string {
  return [JSON.stringify(result.error.issues), result.error.message].join("\n");
}

/** The first issue's message, which callers such as registration show to users. */
function structuralRefusal(env: unknown): { first: string; all: string } {
  const result = ProjectCommandSchema.safeParse({ ...command, env });
  if (result.success) throw new Error("env was unexpectedly accepted");
  return { first: result.error.issues[0]!.message, all: shown(result) };
}

/** A registration of a project whose setup step has this env. */
function registrationRefusal(env: unknown): { first: string; all: string } {
  const result = ProjectDefinitionSchema.safeParse({ ...project, setup: [{ ...command, env }] });
  if (result.success) throw new Error("env was unexpectedly accepted");
  return { first: result.error.issues[0]!.message, all: shown(result) };
}

function registers(env: Record<string, string>): void {
  expect(ProjectDefinitionSchema.parse({ ...project, setup: [{ ...command, env }] }).setup[0]?.env).toEqual(env);
}

describe("env on a project command (#54)", () => {
  it("accepts plain string values under POSIX names", () => {
    const env = { NODE_ENV: "test", CI: "1", _private: "", npm_config_fund: "false", MAVEN_OPTS: "-Xmx2g" };
    expect(ProjectCommandSchema.parse({ ...command, env })).toEqual({ ...command, env });
    registers(env);
  });

  it("parses a command without env as before, adding no field", () => {
    expect(ProjectCommandSchema.parse(command)).toEqual(command);
    expect(Object.hasOwn(ProjectCommandSchema.parse(command), "env")).toBe(false);
  });

  it("refuses names that are not POSIX environment variable names, and says so in the first issue", () => {
    for (const name of ["1ABC", "A-B", "A B", "A=B", "", "NAME\u0000", "ÄBC", `A${"B".repeat(128)}`]) {
      expect(structuralRefusal({ [name]: "x" }).first, name).toMatch(/env names must be POSIX environment variable names/);
    }
  });

  it("refuses a __proto__ name instead of dropping it", () => {
    const env = JSON.parse('{"__proto__": "v", "A": "b"}') as unknown;
    expect(structuralRefusal(env).first).toMatch(/env names must be POSIX environment variable names/);
  });

  it("refuses names AgentX, the worker or the system rely on, in any case, at registration", () => {
    for (const name of [
      "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "IFS", "ENV", "BASH_ENV",
      "AGENTX_WORKSPACE", "agentx_anything", "AWS_REGION", "aws_profile",
      "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_ASKPASS", "GIT_SSH_COMMAND",
      "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "PI_SESSION",
    ]) {
      expect(registrationRefusal({ [name]: "x" }).first, name).toMatch(new RegExp(`env name ${name} is reserved`));
    }
  });

  it("refuses names that look like credentials at registration, and points to credential references", () => {
    for (const name of [
      "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "DB_PASSWORD", "STRIPE_SECRET_KEY",
      "OPENAI_API_KEY", "MY_APIKEY", "SSH_PRIVATE_KEY", "ACCESS_KEY", "AWS_LIKE_ACCESS_KEY_ID", "SERVICE_CREDENTIALS",
      "PGPASSWORD", "auth_token", "MYSQL_PWD", "DB_PASS", "SERVICE_CREDS", "APP_SECRETS",
    ]) {
      expect(registrationRefusal({ [name]: "x" }).first, name).toMatch(new RegExp(`env name ${name} (looks like a credential.*credential reference|is reserved)`));
    }
    // A name that only mentions a credential word, before its end, is not refused.
    registers({
      TOKENIZERS_PARALLELISM: "false", PASSWORDLESS_LOGIN: "1", KEYBOARD_LAYOUT: "us", SECRET_NAME: "payments-db",
      CSRF_TOKEN_NAME: "csrf", SKIP_TOKEN_CHECK: "1", HAS_PASSWORD_RESET: "1", JWT_SECRET_LENGTH: "32", BYPASS: "0",
    });
  });

  it("refuses values that look like secrets at registration", () => {
    for (const value of [
      "postgres://user:hunter2@db.example.test/payments",
      `ghp_${"A1b2C3d4E5".repeat(4)}`,
    ]) {
      const refused = registrationRefusal({ DATABASE_URL: value });
      expect(refused.first).toMatch(/env value of DATABASE_URL looks like a secret.*credential reference/);
      expect(refused.all).not.toContain(value);
    }
    registers({ DATABASE_URL: "postgres://db.example.test/payments", REGISTRY: "https://registry.npmjs.org/" });
  });

  it("refuses non-string values, a NUL byte, a value over 4,096 characters, and more than 64 entries", () => {
    for (const value of [1, true, null, ["a"], { a: "b" }]) {
      expect(() => ProjectCommandSchema.parse({ ...command, env: { NODE_ENV: value } }), JSON.stringify(value)).toThrow();
    }
    expect(() => ProjectCommandSchema.parse({ ...command, env: { NODE_ENV: "a\u0000b" } })).toThrow();
    expect(ProjectCommandSchema.parse({ ...command, env: { BIG: "x".repeat(4_096) } }).env?.BIG).toHaveLength(4_096);
    expect(() => ProjectCommandSchema.parse({ ...command, env: { BIG: "x".repeat(4_097) } })).toThrow();
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`VAR_${index}`, "x"]));
    expect(Object.keys(ProjectCommandSchema.parse({ ...command, env: many(64) }).env ?? {})).toHaveLength(64);
    expect(() => ProjectCommandSchema.parse({ ...command, env: many(65) })).toThrow();
  });

  it("caps the total size of a command's env at 32 KiB", () => {
    const entries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`V${index}`, "x".repeat(4_096)]));
    expect(() => ProjectCommandSchema.parse({ ...command, env: entries(7) })).not.toThrow();
    expect(structuralRefusal(entries(9)).first).toMatch(/env is larger than 32,768 bytes/);
  });

  it("never puts a value in anything a refusal shows", () => {
    const value = "do-not-show-this-value-0123456789";
    const refusals = [
      registrationRefusal({ GITHUB_TOKEN: value }),
      registrationRefusal({ PATH: value }),
      structuralRefusal({ "BAD-NAME": value }),
      structuralRefusal({ NODE_ENV: `${value}\u0000` }),
      structuralRefusal({ NODE_ENV: `${value}${"x".repeat(4_096)}` }),
      structuralRefusal({ NODE_ENV: value, OTHER: 1 }),
    ];
    for (const refused of refusals) expect(refused.all).not.toContain(value);
  });

  it("accepts env on setup and readiness in a project, and a stored revision without env keeps working", () => {
    expect(StoredProjectDefinitionSchema.parse(project)).toMatchObject({ setup: [command], readiness: [{ ...command, args: ["test"] }] });
    expect(StoredProjectDefinitionSchema.parse(project).setup[0]).not.toHaveProperty("env");
    const withEnv = { ...project, setup: [{ ...command, env: { CI: "1" } }], readiness: [{ ...command, env: { NODE_ENV: "test" } }] };
    expect(ProjectDefinitionSchema.parse(withEnv).setup[0]?.env).toEqual({ CI: "1" });
    expect(ProjectDefinitionSchema.parse(withEnv).readiness[0]?.env).toEqual({ NODE_ENV: "test" });
    expect(() => ProjectDefinitionSchema.parse({ ...project, readiness: [{ ...command, env: { AWS_REGION: "us-east-1" } }] })).toThrow(/reserved/);
  });

  it("reads a stored revision whose env a later name rule would refuse, so tightening the rules never strands a revision", () => {
    const stored = { ...project, setup: [{ ...command, env: { GITHUB_TOKEN: "x", PATH: "/opt/bin" } }] };
    expect(StoredProjectDefinitionSchema.parse(stored).setup[0]?.env).toEqual({ GITHUB_TOKEN: "x", PATH: "/opt/bin" });
    // Its structure is still checked.
    expect(() => StoredProjectDefinitionSchema.parse({ ...project, setup: [{ ...command, env: { "BAD-NAME": "x" } }] })).toThrow();
  });
});
