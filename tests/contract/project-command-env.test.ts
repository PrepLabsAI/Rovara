import { ProjectCommandSchema, ProjectDefinitionSchema, StoredProjectDefinitionSchema } from "../../packages/contracts/src/project.js";
import { describe, expect, it } from "vitest";

// #54 (first slice): a project command may set environment variables for itself.
const command = { cwd: "repo/payments-api", executable: "npm", args: ["ci"], timeoutSeconds: 600 };

function refusal(env: unknown): string {
  const result = ProjectCommandSchema.safeParse({ ...command, env });
  if (result.success) throw new Error("env was unexpectedly accepted");
  return result.error.issues.map((issue) => issue.message).join("\n");
}

describe("env on a project command (#54)", () => {
  it("accepts plain string values under POSIX names", () => {
    const env = { NODE_ENV: "test", CI: "1", _private: "", npm_config_fund: "false", MAVEN_OPTS: "-Xmx2g" };
    expect(ProjectCommandSchema.parse({ ...command, env })).toEqual({ ...command, env });
  });

  it("parses a command without env as before, adding no field", () => {
    expect(ProjectCommandSchema.parse(command)).toEqual(command);
    expect(Object.hasOwn(ProjectCommandSchema.parse(command), "env")).toBe(false);
  });

  it("refuses names that are not POSIX environment variable names", () => {
    for (const name of ["1ABC", "A-B", "A B", "A=B", "", "NAME\u0000", "ÄBC"]) {
      expect(() => ProjectCommandSchema.parse({ ...command, env: { [name]: "x" } }), name).toThrow();
    }
    expect(() => ProjectCommandSchema.parse({ ...command, env: { [`A${"B".repeat(128)}`]: "x" } })).toThrow();
  });

  it("refuses names AgentX, the worker or the system rely on, in any case", () => {
    for (const name of [
      "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "IFS", "ENV", "BASH_ENV",
      "AGENTX_WORKSPACE", "agentx_anything", "AWS_REGION", "aws_profile",
      "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_ASKPASS", "GIT_SSH_COMMAND",
      "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "PI_SESSION",
    ]) {
      expect(refusal({ [name]: "x" }), name).toMatch(new RegExp(`env name ${name} is reserved`));
    }
  });

  it("refuses names that look like credentials, and points to credential references", () => {
    for (const name of [
      "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "DB_PASSWORD", "STRIPE_SECRET_KEY",
      "OPENAI_API_KEY", "MY_APIKEY", "SSH_PRIVATE_KEY", "ACCESS_KEY", "SERVICE_CREDENTIALS", "PGPASSWORD", "auth_token",
    ]) {
      expect(refusal({ [name]: "x" }), name).toMatch(new RegExp(`env name ${name} looks like a credential.*credential reference`));
    }
    // A word that only contains a credential word is not refused.
    const allowed = { TOKENIZERS_PARALLELISM: "false", PASSWORDLESS_LOGIN: "1", KEYBOARD_LAYOUT: "us" };
    expect(ProjectCommandSchema.parse({ ...command, env: allowed }).env).toEqual(allowed);
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
    expect(refusal(entries(9))).toMatch(/env is larger than 32,768 bytes/);
  });

  it("never puts a value in a refusal message", () => {
    const value = "do-not-show-this-value-0123456789";
    const messages = [
      refusal({ GITHUB_TOKEN: value }),
      refusal({ PATH: value }),
      refusal({ "BAD-NAME": value }),
      refusal({ NODE_ENV: `${value}\u0000` }),
      refusal({ NODE_ENV: `${value}${"x".repeat(4_096)}` }),
    ];
    for (const message of messages) expect(message).not.toContain(value);
  });

  it("accepts env on setup and readiness in a project, and a stored revision without env keeps working", () => {
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
    expect(StoredProjectDefinitionSchema.parse(project)).toMatchObject({ setup: [command], readiness: [{ ...command, args: ["test"] }] });
    expect(StoredProjectDefinitionSchema.parse(project).setup[0]).not.toHaveProperty("env");
    const withEnv = { ...project, setup: [{ ...command, env: { CI: "1" } }], readiness: [{ ...command, env: { NODE_ENV: "test" } }] };
    expect(ProjectDefinitionSchema.parse(withEnv).setup[0]?.env).toEqual({ CI: "1" });
    expect(ProjectDefinitionSchema.parse(withEnv).readiness[0]?.env).toEqual({ NODE_ENV: "test" });
    expect(() => ProjectDefinitionSchema.parse({ ...project, setup: [{ ...command, env: { AWS_REGION: "us-east-1" } }] })).toThrow(/reserved/);
  });
});
