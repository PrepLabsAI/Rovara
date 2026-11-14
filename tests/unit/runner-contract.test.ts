// SH35: the team build runner contract (R3). Strict job kinds, no model credentials or edit permissions on a job, jobs made only of approved commands, bounded sizes, a signed grant, a lease that binds a result
// to one job, and a result that is only evidence.
import { describe, expect, it, vi } from "vitest";
import {
  RUNNER_GRANT_MAX_BYTES, RUNNER_GRANT_SIGNER, RUNNER_JOB_KINDS, RUNNER_JOB_MAX_TOTAL_SECONDS, RUNNER_LEASE_MAX_SECONDS, RUNNER_MAX_COMMANDS, RUNNER_MESSAGE_MAX_BYTES, RUNNER_OUTPUT_TAIL_BYTES, RUNNER_RESULT_MAX_BYTES, RUNNER_SCAN_MAX_KEYS,
  RunnerGrantSchema, RunnerHeartbeatAckSchema, RunnerHeartbeatSchema, RunnerIdSchema, RunnerJobSchema, RunnerLeaseSchema, RunnerResultSchema, TestEnvironmentBodySchema,
  checkRunnerHeartbeat, checkRunnerJobEnvironment, readRunnerBody, checkRunnerResult, findRunnerForbiddenField, forbiddenRunnerEnvName, runnerCommandDigest, runnerGrantSigningInput, runnerJobDigest, runnerLeaseRecord, testEnvDigest,
  type RunnerCheckState, type RunnerJob,
} from "../../packages/contracts/src/index.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const LEASE_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const COMMIT = "a".repeat(40);
const TOKEN = "T".repeat(43);
const BEAT = "H".repeat(43);
const ENV_DIGEST = "e".repeat(64);
const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

const command = (over: Record<string, unknown> = {}) => ({ cwd: "service", executable: "pytest", args: ["-q"], timeoutSeconds: 600, ...over });
const workspace = () => ({ repositories: [{ repositoryId: "service", commit: COMMIT }], envRevision: 3 });
const job = (over: Record<string, unknown> = {}) => ({ version: 1, jobId: JOB_ID, kind: "run_checks", workspace: workspace(), commands: [command()], environmentDigest: ENV_DIGEST, ...over });
const setupJob = (over: Record<string, unknown> = {}) => {
  const { environmentDigest: _unused, ...rest } = job();
  void _unused;
  return { ...rest, kind: "setup_command", personApprovalId: OPERATION_ID, approvedBy: "person-7", approvedCommandSha256: runnerCommandDigest(command()), ...over };
};
const lease = (over: Record<string, unknown> = {}) => ({
  leaseId: LEASE_ID, jobId: JOB_ID, runnerId: "build-host-1", operationId: OPERATION_ID, fence: 4, issuedAt: at(0), expiresAt: at(60), hardDeadlineAt: at(3_600),
  heartbeat: { intervalSeconds: 15, missedAllowed: 3 }, singleUse: true, leaseToken: TOKEN, heartbeatCapability: BEAT, ...over,
});
const signature = () => ({ signer: RUNNER_GRANT_SIGNER, algorithm: "ECDSA_SHA_256", keyId: "alias/rovara-runner-grants", value: "QUJD".repeat(20) });
const grant = (jobOver: Record<string, unknown> = {}, leaseOver: Record<string, unknown> = {}) => ({ version: 1, lease: lease(leaseOver), job: job(jobOver), signature: signature() });
const commandResult = (index: number, over: Record<string, unknown> = {}) => ({ index, exitCode: 0, timedOut: false, durationMs: 1_000, outputTail: "ok\n", outputCut: false, ...over });
const resultFor = (jobValue: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  version: 1, jobId: JOB_ID, leaseId: LEASE_ID, runnerId: "build-host-1", fence: 4, kind: "run_checks", jobDigest: runnerJobDigest(RunnerJobSchema.parse(jobValue)), workspace: workspace(), outcome: "finished",
  commands: [commandResult(0)], finishedAt: at(120), leaseToken: TOKEN, ...over,
});
const result = (over: Record<string, unknown> = {}) => resultFor(job(), over);
const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const messages = (schema: { safeParse(value: unknown): { error?: { issues: unknown[] } } }, value: unknown) => JSON.stringify(schema.safeParse(value).error?.issues ?? []);

describe("job kinds are strict", () => {
  it("are exactly setup_command, run_checks, prove and nightly", () => {
    expect([...RUNNER_JOB_KINDS]).toEqual(["setup_command", "run_checks", "prove", "nightly"]);
    for (const kind of ["run_checks", "prove", "nightly"]) expect(ok(RunnerJobSchema, job({ kind })), kind).toBe(true);
    expect(ok(RunnerJobSchema, setupJob())).toBe(true);
  });

  it("refuses any other kind: an agent step, a publish, a model call, an unknown or missing kind", () => {
    for (const kind of ["agent", "task", "publish", "prepare", "maintain", "model_call", "edit", "RUN_CHECKS", "", undefined, 1]) {
      expect(ok(RunnerJobSchema, job({ kind })), String(kind)).toBe(false);
    }
  });

  it("holds a setup command to one command that a person approved, and only that kind to the approval fields", () => {
    expect(ok(RunnerJobSchema, setupJob({ personApprovalId: undefined }))).toBe(false);
    expect(ok(RunnerJobSchema, setupJob({ commands: [command(), command()] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ kind: "run_checks", personApprovalId: OPERATION_ID }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ kind: "run_checks", approvedBy: "p", approvedCommandSha256: "a".repeat(64) }))).toBe(false);
    expect(ok(RunnerJobSchema, { ...setupJob(), environmentDigest: ENV_DIGEST })).toBe(false);
  });

  it("refuses unknown fields, empty command lists, and a non-setup job without its environment digest", () => {
    for (const kind of RUNNER_JOB_KINDS) {
      const base = kind === "setup_command" ? setupJob() : job({ kind });
      expect(ok(RunnerJobSchema, base), kind).toBe(true);
      expect(ok(RunnerJobSchema, { ...base, surprise: 1 }), kind).toBe(false);
    }
    for (const kind of ["run_checks", "prove", "nightly"]) expect(ok(RunnerJobSchema, job({ kind, environmentDigest: undefined })), kind).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [command({ extra: true })] }))).toBe(false);
  });
});

describe("a setup command is the one command a person approved (A)", () => {
  it("must carry the digest of its own command, the approver and the approval", () => {
    const digest = runnerCommandDigest(command());
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(ok(RunnerJobSchema, setupJob())).toBe(true);
    expect(ok(RunnerJobSchema, setupJob({ approvedCommandSha256: "0".repeat(64) }))).toBe(false);
    expect(messages(RunnerJobSchema, setupJob({ approvedCommandSha256: "0".repeat(64) }))).toContain("not the digest of the command");
    // Any change to the command (arguments, timeout, directory, environment) changes the digest the approval was for.
    for (const changed of [command({ args: ["-q", "--x"] }), command({ timeoutSeconds: 601 }), command({ cwd: "other" }), command({ env: { CI: "1" } }), command({ executable: "pytest2" })]) {
      expect(ok(RunnerJobSchema, setupJob({ commands: [changed] })), JSON.stringify(changed)).toBe(false);
    }
    expect(ok(RunnerJobSchema, setupJob({ approvedBy: "" }))).toBe(false);
    expect(ok(RunnerJobSchema, setupJob({ approvedBy: "a b" }))).toBe(false);
    expect(ok(RunnerJobSchema, setupJob({ approvedBy: undefined }))).toBe(false);
  });
});

describe("an environment job is made only of an approved environment's commands (B, C)", () => {
  const setup = command({ executable: "uv", args: ["sync", "--frozen"], env: { CI: "1" }, timeoutSeconds: 900 });
  const unit = command({ args: ["-q", "tests/unit"], timeoutSeconds: 1_800 });
  const environment = TestEnvironmentBodySchema.parse({
    tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [setup], checks: [{ id: "unit", label: "Unit", command: unit, kind: "test" }] }], roundBudgetMin: 30,
    selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
    prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  });
  const digest = testEnvDigest(environment);
  const approved = { revision: 3, environment };
  const make = (commands: unknown[], over: Record<string, unknown> = {}): RunnerJob => RunnerJobSchema.parse(job({ kind: "prove", environmentDigest: digest, commands, ...over }));

  it("accepts the environment's setup and check commands, exactly", () => {
    expect(checkRunnerJobEnvironment(make([setup, unit]), approved)).toEqual({ ok: true });
  });

  it("binds the workspace: the environment's revision and exactly its repositories", () => {
    expect(checkRunnerJobEnvironment(make([unit], { workspace: { ...workspace(), envRevision: 4 } }), approved)).toEqual({ ok: false, reason: "wrong_revision" });
    expect(checkRunnerJobEnvironment(make([unit]), { revision: 2, environment })).toEqual({ ok: false, reason: "wrong_revision" });
    const pin = (ids: string[]) => ({ ...workspace(), repositories: ids.map((repositoryId) => ({ repositoryId, commit: COMMIT })) });
    expect(checkRunnerJobEnvironment(make([unit], { workspace: pin(["service", "other"]) }), approved)).toEqual({ ok: false, reason: "wrong_repositories" });
    expect(checkRunnerJobEnvironment(make([unit], { workspace: pin(["other"]) }), approved)).toEqual({ ok: false, reason: "wrong_repositories" });
    expect(checkRunnerJobEnvironment(make([unit], { workspace: pin(["service"]) }), approved)).toEqual({ ok: true });
  });

  it("is kind-specific: run_checks carries check commands only, prove and nightly carry setup and checks", () => {
    const of = (kind: string, commands: unknown[]) => RunnerJobSchema.parse(job({ kind, environmentDigest: digest, commands }));
    expect(checkRunnerJobEnvironment(of("run_checks", [unit]), approved)).toEqual({ ok: true });
    expect(checkRunnerJobEnvironment(of("run_checks", [setup]), approved)).toEqual({ ok: false, reason: "command_not_allowed_for_kind" });
    expect(checkRunnerJobEnvironment(of("run_checks", [unit, setup]), approved)).toEqual({ ok: false, reason: "command_not_allowed_for_kind" });
    for (const kind of ["prove", "nightly"]) expect(checkRunnerJobEnvironment(of(kind, [setup, unit]), approved), kind).toEqual({ ok: true });
  });

  it("refuses a command listed twice", () => {
    expect(checkRunnerJobEnvironment(make([unit, unit]), approved)).toEqual({ ok: false, reason: "duplicate_command" });
    expect(checkRunnerJobEnvironment(make([setup, unit, setup]), approved)).toEqual({ ok: false, reason: "duplicate_command" });
  });

  it("refuses another environment, a command that is not in it, and a changed command", () => {
    expect(checkRunnerJobEnvironment(make([unit], { environmentDigest: "d".repeat(64) }), approved)).toEqual({ ok: false, reason: "wrong_environment" });
    expect(checkRunnerJobEnvironment(make([command({ executable: "sh", args: ["-c", "echo hi"] })]), approved)).toEqual({ ok: false, reason: "command_not_in_environment" });
    expect(checkRunnerJobEnvironment(make([{ ...unit, args: ["-q", "tests/unit", "--extra"] }]), approved)).toEqual({ ok: false, reason: "command_not_in_environment" });
    expect(checkRunnerJobEnvironment(make([{ ...unit, timeoutSeconds: 1_801 }]), approved)).toEqual({ ok: false, reason: "command_not_in_environment" });
  });

  it("holds every environment variable name to the names the environment itself sets", () => {
    expect(checkRunnerJobEnvironment(make([{ ...unit, env: { CI: "1" } }]), approved)).toEqual({ ok: false, reason: "command_not_in_environment" });
    // The same command with a name the environment never sets is refused for the name first.
    expect(checkRunnerJobEnvironment(make([{ ...unit, env: { EXTRA_FLAG: "1" } }]), approved)).toEqual({ ok: false, reason: "env_name_not_in_environment" });
  });

  it("is not for a setup command, which is bound by its approval digest", () => {
    expect(checkRunnerJobEnvironment(RunnerJobSchema.parse(setupJob()), approved)).toEqual({ ok: false, reason: "not_an_environment_job" });
  });
});

describe("a job never carries model credentials or edit permissions", () => {
  const forbidden: Array<[string, Record<string, unknown>]> = [
    ["model", { model: "some-model" }], ["modelCredentials", { modelCredentials: { apiKey: "x" } }], ["apiKey", { apiKey: "x" }], ["provider", { provider: "anthropic" }], ["prompt", { prompt: "do the thing" }],
    ["tools", { tools: ["bash", "edit"] }], ["allowedTools", { allowedTools: ["write"] }], ["editPermissions", { editPermissions: { write: true } }], ["canWrite", { canWrite: true }], ["writeAccess", { writeAccess: true }],
    ["permissions", { permissions: ["edit"] }], ["secrets", { secrets: {} }], ["token", { token: "x" }], ["password", { password: "x" }], ["authorization", { authorization: "x" }], ["callbackToken", { callbackToken: "x" }],
  ];
  it.each(forbidden)("refuses %s at the top of a job", (name, extra) => {
    expect(ok(RunnerJobSchema, job(extra)), name).toBe(false);
    expect(ok(RunnerGrantSchema, grant(extra)), name).toBe(false);
  });

  it("names the field in its own sentence, not only as an unknown key", () => {
    expect(messages(RunnerJobSchema, job({ modelCredentials: {} }))).toContain("stay central");
    expect(findRunnerForbiddenField(job({ nested: [{ deep: { editPermissions: 1 } }] }))).toEqual({ path: "nested.0.deep.editPermissions", reason: "forbidden" });
  });

  it("refuses them anywhere in the object, inside a command or the workspace pin", () => {
    expect(ok(RunnerJobSchema, job({ commands: [command({ model: "x" })] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ workspace: { ...workspace(), apiKey: "x" } }))).toBe(false);
  });

  it("refuses a command that sets a credential or model-access environment variable (C)", () => {
    const names = [
      "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_ORG", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_REGION", "AGENTX_MODEL", "ROVARA_BROKER_URL", "GITHUB_TOKEN", "DB_PASSWORD", "NPM_AUTH_TOKEN", "BEDROCK_PROFILE",
      "CLAUDE_CONFIG_DIR", "GH_HOST", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "GIT_ASKPASS", "SSH_AUTH_SOCK", "SSH_COMMAND", "DEPLOY_PAT", "SENTRY_DSN", "x_gemini_x", "X_CLAUDE_DIR", "MY_ANTHROPIC_URL", "X_OPENAI_Y", "MY_BEDROCK_X", "X_SAGEMAKER_Y", "my_prompt", "MY_PROVIDER", "VERTEX_LOCATION", "my_vertex", "SAGEMAKER_ROLE", "USE_MODEL", "MODEL_CACHE", "SYSTEM_PROMPT_FILE", "LLM_PROVIDER",
    ];
    for (const name of names) {
      expect(forbiddenRunnerEnvName(name), name).toBe(true);
      expect(ok(RunnerJobSchema, job({ commands: [command({ env: { [name]: "1" } })] })), name).toBe(false);
    }
    for (const name of ["CI", "PYTHONHASHSEED", "NODE_ENV", "GITHUB_ACTIONS", "PATH_EXTRA", "GITLAB_CI", "SSHD"]) expect(forbiddenRunnerEnvName(name), name).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [command({ env: { CI: "1", PYTHONHASHSEED: "0", NODE_ENV: "test" } })] }))).toBe(true);
  });

  it("refuses a credential-shaped argument or environment value", () => {
    // Built at run time: no key-shaped text sits in this file.
    const shaped = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    const bearer = `Authorization: Bearer ${"Zy9".repeat(12)}`;
    expect(ok(RunnerJobSchema, job({ commands: [command({ args: ["--header", bearer] })] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [command({ env: { MARKER: shaped } })] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [command({ args: [shaped] })] }))).toBe(false);
  });

  it("refuses zero-width, bidirectional and other format characters in arguments, values and the executable (D)", () => {
    for (const hidden of ["​", "‍", "⁠", "﻿", "‮", "⁦", "­"]) {
      const label = `U+${hidden.codePointAt(0)?.toString(16) ?? ""}`;
      expect(ok(RunnerJobSchema, job({ commands: [command({ args: [`-q${hidden}`] })] })), `arg ${label}`).toBe(false);
      expect(ok(RunnerJobSchema, job({ commands: [command({ env: { CI: `1${hidden}` } })] })), `env ${label}`).toBe(false);
      expect(ok(RunnerJobSchema, job({ commands: [command({ executable: `pytest${hidden}` })] })), `exe ${label}`).toBe(false);
    }
    expect(ok(RunnerJobSchema, job({ commands: [command({ args: ["-q", "tests/é/日本"] })] }))).toBe(true);
  });

  it("refuses control characters (ESC, CR, LF, NUL, DEL) and format characters in the directory, the executable, arguments and values", () => {
    for (const bad of ["\u001b", "\r", "\n", "\u0000", "\u007f", "\u0007", "\u200b", "\u202e"]) {
      const label = JSON.stringify(bad);
      expect(ok(RunnerJobSchema, job({ commands: [command({ args: [`-q${bad}x`] })] })), `arg ${label}`).toBe(false);
      expect(ok(RunnerJobSchema, job({ commands: [command({ env: { CI: `1${bad}` } })] })), `env ${label}`).toBe(false);
      expect(ok(RunnerJobSchema, job({ commands: [command({ executable: `pytest${bad}` })] })), `exe ${label}`).toBe(false);
      expect(ok(RunnerJobSchema, job({ commands: [command({ cwd: `ser${bad}vice` })] })), `cwd ${label}`).toBe(false);
    }
    // The command schema itself holds the rule, whatever the path schema thinks of the directory.
    expect(messages(RunnerJobSchema, job({ commands: [command({ args: ["a\nb"] })] }))).toContain("control characters");
  });

  it("allows the two lease secrets in their one place each only", () => {
    expect(ok(RunnerGrantSchema, grant())).toBe(true);
    expect(ok(RunnerGrantSchema, { ...grant(), job: job({ leaseToken: TOKEN }) })).toBe(false);
    expect(ok(RunnerGrantSchema, { ...grant(), leaseToken: TOKEN })).toBe(false);
    expect(ok(RunnerGrantSchema, { ...grant(), job: job({ heartbeatCapability: BEAT }) })).toBe(false);
    expect(ok(RunnerLeaseSchema, lease())).toBe(true);
    expect(ok(RunnerLeaseSchema, lease({ accessToken: TOKEN }))).toBe(false);
  });
});

describe("a grant is signed by the control plane (placeholder)", () => {
  it("must carry the signature envelope, from the named signer", () => {
    expect(RUNNER_GRANT_SIGNER).toBe("rovara-control-plane-kms");
    expect(ok(RunnerGrantSchema, grant())).toBe(true);
    const { signature: _drop, ...unsigned } = grant();
    void _drop;
    expect(ok(RunnerGrantSchema, unsigned)).toBe(false);
    for (const bad of [{ signer: "runner" }, { algorithm: "none" }, { keyId: "" }, { value: "" }, { value: "not base64!" }, { extra: 1 }]) {
      expect(ok(RunnerGrantSchema, { ...grant(), signature: { ...signature(), ...bad } }), JSON.stringify(bad)).toBe(false);
    }
  });

  it("signs the version, lease and job as canonical JSON, never the signature", () => {
    const parsed = RunnerGrantSchema.parse(grant());
    const text = runnerGrantSigningInput(parsed);
    expect(text).toContain(JOB_ID);
    expect(text).toContain(LEASE_ID);
    expect(text).not.toContain("ECDSA_SHA_256");
    expect(runnerGrantSigningInput(RunnerGrantSchema.parse({ ...grant(), signature: { ...signature(), value: "WFla".repeat(20) } }))).toBe(text);
    expect(runnerGrantSigningInput(RunnerGrantSchema.parse(grant({ commands: [command({ timeoutSeconds: 601 })] })))).not.toBe(text);
  });
});

describe("sizes are bounded", () => {
  it("limits commands, timeouts, patch size and the whole grant", () => {
    expect(ok(RunnerJobSchema, job({ commands: Array.from({ length: RUNNER_MAX_COMMANDS }, () => command({ timeoutSeconds: 60 })) }))).toBe(true);
    expect(ok(RunnerJobSchema, job({ commands: Array.from({ length: RUNNER_MAX_COMMANDS + 1 }, () => command({ timeoutSeconds: 60 })) }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [command({ timeoutSeconds: RUNNER_JOB_MAX_TOTAL_SECONDS })] }))).toBe(true);
    expect(ok(RunnerJobSchema, job({ commands: [command({ timeoutSeconds: RUNNER_JOB_MAX_TOTAL_SECONDS }), command({ timeoutSeconds: 1 })] }))).toBe(false);
    const patch = { repositoryId: "service", sha256: "b".repeat(64), sizeBytes: 1_048_576 };
    expect(ok(RunnerJobSchema, job({ candidatePatch: patch }))).toBe(true);
    expect(ok(RunnerJobSchema, job({ candidatePatch: { ...patch, sizeBytes: 1_048_577 } }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ candidatePatch: { ...patch, repositoryId: "other" } }))).toBe(false);
    const bigCommands = (count: number, args: number, size: number) => Array.from({ length: count }, () => command({ args: Array.from({ length: args }, () => "x".repeat(size)), timeoutSeconds: 60 }));
    // Every part is within its own limit; only the whole is too large.
    const big = { ...grant(), job: job({ commands: bigCommands(8, 8, 8_000) }) };
    expect(JSON.stringify(big).length).toBeGreaterThan(RUNNER_GRANT_MAX_BYTES);
    expect(ok(RunnerGrantSchema, { ...grant(), job: job({ commands: bigCommands(2, 8, 8_000) }) })).toBe(true);
    expect(ok(RunnerGrantSchema, big)).toBe(false);
    expect(messages(RunnerGrantSchema, big)).toContain("bytes");
    expect(ok(RunnerJobSchema, big.job)).toBe(false);
  });

  it("counts object keys, not array items, so a valid message of the largest shape is read (E)", () => {
    // The largest shape the bounds allow: 64 commands, each with 64 environment names. It must be read, not refused for its size.
    const env = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`VAR_${String(index)}`, "1"]));
    const widest = job({ commands: Array.from({ length: RUNNER_MAX_COMMANDS }, () => command({ env, timeoutSeconds: 60 })) });
    expect(findRunnerForbiddenField(widest)).toBeUndefined();
    expect(ok(RunnerJobSchema, widest)).toBe(true);
    // Many array items are no keys: 5,000 short arguments are within the key cap (they are bounded by the byte limit and each command's own limit).
    expect(findRunnerForbiddenField({ args: Array.from({ length: 20_000 }, () => "x") })).toBeUndefined();
    expect(RUNNER_SCAN_MAX_KEYS).toBeGreaterThan(RUNNER_MAX_COMMANDS * 64);
  });

  it("gives a message with more keys than the largest valid one its own sentence", () => {
    const manyKeys = Object.fromEntries(Array.from({ length: RUNNER_SCAN_MAX_KEYS + 1 }, (_, index) => [`k${String(index)}`, 1]));
    expect(findRunnerForbiddenField(manyKeys)).toMatchObject({ reason: "too_many_fields" });
    const parsed = messages(RunnerJobSchema, job({ extra: manyKeys }));
    expect(parsed).toContain("more fields than the largest valid message");
    expect(parsed).not.toContain("stay central");
    let deep: unknown = 1;
    for (let level = 0; level < 20; level += 1) deep = { a: deep };
    expect(findRunnerForbiddenField(deep)).toMatchObject({ reason: "too_deep" });
  });

  it("bounds the lease: ordering, lifetime, heartbeat and that the commands fit in it", () => {
    expect(ok(RunnerLeaseSchema, lease({ expiresAt: at(0) }))).toBe(false);
    expect(ok(RunnerLeaseSchema, lease({ hardDeadlineAt: at(30) }))).toBe(false);
    expect(ok(RunnerLeaseSchema, lease({ hardDeadlineAt: at(RUNNER_LEASE_MAX_SECONDS) }))).toBe(true);
    expect(ok(RunnerLeaseSchema, lease({ hardDeadlineAt: at(RUNNER_LEASE_MAX_SECONDS + 1) }))).toBe(false);
    for (const heartbeat of [{ intervalSeconds: 4, missedAllowed: 3 }, { intervalSeconds: 61, missedAllowed: 3 }, { intervalSeconds: 15, missedAllowed: 0 }, { intervalSeconds: 15, missedAllowed: 6 }]) {
      expect(ok(RunnerLeaseSchema, lease({ heartbeat })), JSON.stringify(heartbeat)).toBe(false);
    }
    expect(ok(RunnerGrantSchema, grant({ commands: [command({ timeoutSeconds: 7_200 })] }))).toBe(false);
    expect(ok(RunnerGrantSchema, grant({ jobId: OPERATION_ID }))).toBe(false);
  });

  it("measures each output tail as written in JSON (F)", () => {
    const tail = (text: string) => result({ commands: [commandResult(0, { outputTail: text })] });
    expect(ok(RunnerResultSchema, tail("a".repeat(RUNNER_OUTPUT_TAIL_BYTES)))).toBe(true);
    expect(ok(RunnerResultSchema, tail("a".repeat(RUNNER_OUTPUT_TAIL_BYTES + 1)))).toBe(false);
    // 2,048 two-byte characters are 4,096 bytes; 2,049 are over.
    expect(ok(RunnerResultSchema, tail("é".repeat(2_048)))).toBe(true);
    expect(ok(RunnerResultSchema, tail("é".repeat(2_049)))).toBe(false);
    // A newline is two bytes once written: 2,048 fit, 2,049 do not, though they are far fewer than 4,096 characters.
    expect(ok(RunnerResultSchema, tail("\n".repeat(2_048)))).toBe(true);
    expect(ok(RunnerResultSchema, tail("\n".repeat(2_049)))).toBe(false);
    expect(ok(RunnerResultSchema, tail('"'.repeat(2_049)))).toBe(false);
  });

  it("limits the whole result, and keeps the worst valid result inside the limit (F)", () => {
    const many = result({ commands: Array.from({ length: RUNNER_MAX_COMMANDS + 1 }, (_, index) => commandResult(index)) });
    expect(ok(RunnerResultSchema, many)).toBe(false);
    for (const unit of ["a", "\n", "é"]) {
      const text = unit === "é" ? unit.repeat(2_048) : unit.repeat(unit === "\n" ? 2_048 : RUNNER_OUTPUT_TAIL_BYTES);
      const full = result({ commands: Array.from({ length: RUNNER_MAX_COMMANDS }, (_, index) => commandResult(index, { outputTail: text })) });
      expect(new TextEncoder().encode(JSON.stringify(full)).length, unit).toBeLessThan(RUNNER_RESULT_MAX_BYTES);
      expect(ok(RunnerResultSchema, full), unit).toBe(true);
    }
    expect(ok(RunnerResultSchema, { ...result(), padding: "x".repeat(RUNNER_RESULT_MAX_BYTES) })).toBe(false);
    expect(messages(RunnerResultSchema, { ...result(), padding: "x".repeat(RUNNER_RESULT_MAX_BYTES) })).toContain("bytes");
    expect(ok(RunnerResultSchema, result({ commands: [commandResult(0, { exitCode: 256 })] }))).toBe(false);
  });

  it("takes plain text only: CRLF is tolerated; ANSI escapes, other controls and format characters are not (F)", () => {
    const tail = (text: string) => result({ commands: [commandResult(0, { outputTail: text })] });
    expect(ok(RunnerResultSchema, tail("line\r\nnext\n\ttab"))).toBe(true);
    for (const bad of ["bell\u0007", "\u001b[31mred\u001b[0m", "nul\u0000", "‮evil", "zero​width", "⁦isolate", "﻿bom", "del\u007f"]) {
      expect(ok(RunnerResultSchema, tail(bad)), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("a result is evidence bound to its lease (G)", () => {
  const jobValue = job({ commands: [command(), command()] });
  const issued = RunnerGrantSchema.parse({ ...grant(), job: jobValue });
  const record = runnerLeaseRecord(issued);
  const state = (over: Partial<RunnerCheckState> = {}): RunnerCheckState => ({ redeemed: false, now: NOW + 120_000, currentFence: 4, ...over });
  const parsed = (over: Record<string, unknown> = {}) => RunnerResultSchema.parse(resultFor(jobValue, { commands: [commandResult(0), commandResult(1)], ...over }));

  it("matches the lease it answers", () => {
    expect(checkRunnerResult(record, parsed(), state())).toEqual({ ok: true });
  });

  it("keeps only the hash of the token and of the heartbeat capability", () => {
    const stored = JSON.stringify(record);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(BEAT);
    expect(record.leaseTokenSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.heartbeatCapabilitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.leaseTokenSha256).not.toBe(record.heartbeatCapabilitySha256);
    expect(record.lease).not.toHaveProperty("leaseToken");
    expect(record.lease).not.toHaveProperty("heartbeatCapability");
  });

  it("is refused when the lease was already redeemed, the fence is stale, or the time is outside the lease", () => {
    expect(checkRunnerResult(record, parsed(), state({ redeemed: true }))).toEqual({ ok: false, reason: "already_redeemed" });
    expect(checkRunnerResult(record, parsed(), state({ currentFence: 5 }))).toEqual({ ok: false, reason: "stale_fence" });
    expect(checkRunnerResult(record, parsed({ fence: 3 }), state({ currentFence: 3 }))).toEqual({ ok: false, reason: "stale_fence" });
    expect(checkRunnerResult(record, parsed({ fence: 3 }), state())).toEqual({ ok: false, reason: "stale_fence" });
    expect(checkRunnerResult(record, parsed(), state({ now: NOW - 1 }))).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(checkRunnerResult(record, parsed(), state({ now: NOW + 3_600_000 + 1 }))).toEqual({ ok: false, reason: "expired" });
    expect(checkRunnerResult(record, parsed(), state({ now: NOW + 3_600_000 }))).toEqual({ ok: true });
  });

  it("is voided by another job, lease, runner, kind, job digest, token or workspace pin", () => {
    expect(checkRunnerResult(record, parsed({ jobId: OPERATION_ID }), state())).toEqual({ ok: false, reason: "wrong_job" });
    expect(checkRunnerResult(record, parsed({ leaseId: OPERATION_ID }), state())).toEqual({ ok: false, reason: "wrong_lease" });
    expect(checkRunnerResult(record, parsed({ kind: "nightly" }), state())).toEqual({ ok: false, reason: "wrong_lease" });
    expect(checkRunnerResult(record, parsed({ runnerId: "other-host" }), state())).toEqual({ ok: false, reason: "wrong_runner" });
    expect(checkRunnerResult(record, parsed({ jobDigest: "0".repeat(64) }), state())).toEqual({ ok: false, reason: "wrong_job_digest" });
    // The same ids over a different job (one more command, say) are another job's result.
    expect(checkRunnerResult(record, parsed({ jobDigest: runnerJobDigest(RunnerJobSchema.parse(job({ commands: [command()] }))) }), state())).toEqual({ ok: false, reason: "wrong_job_digest" });
    expect(checkRunnerResult(record, parsed({ leaseToken: "U".repeat(43) }), state())).toEqual({ ok: false, reason: "wrong_token" });
    expect(checkRunnerResult(record, parsed({ workspace: { ...workspace(), envRevision: 4 } }), state())).toEqual({ ok: false, reason: "wrong_workspace" });
    expect(checkRunnerResult(record, parsed({ workspace: { ...workspace(), repositories: [{ repositoryId: "service", commit: "b".repeat(40) }] } }), state())).toEqual({ ok: false, reason: "wrong_workspace" });
  });

  it("fails closed on a clock that is not a finite number, and on a stale-fence value that is not a number", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined as unknown as number, "now" as unknown as number]) {
      expect(checkRunnerResult(record, parsed(), state({ now })), String(now)).toEqual({ ok: false, reason: "bad_clock" });
    }
  });

  it("refuses a finishedAt outside the lease window", () => {
    expect(checkRunnerResult(record, parsed({ finishedAt: at(-1) }), state())).toEqual({ ok: false, reason: "finished_outside_lease" });
    expect(checkRunnerResult(record, parsed({ finishedAt: at(3_601) }), state())).toEqual({ ok: false, reason: "finished_outside_lease" });
    expect(checkRunnerResult(record, parsed({ finishedAt: at(0) }), state())).toEqual({ ok: true });
    expect(checkRunnerResult(record, parsed({ finishedAt: at(3_600) }), state())).toEqual({ ok: true });
  });

  it("holds no more commands than the job has, and all of them when it says finished", () => {
    expect(checkRunnerResult(record, parsed({ commands: [commandResult(0), commandResult(1), commandResult(2)] }), state())).toEqual({ ok: false, reason: "too_many_commands" });
    expect(checkRunnerResult(record, parsed({ commands: [commandResult(0)] }), state())).toEqual({ ok: false, reason: "incomplete" });
    expect(checkRunnerResult(record, parsed({ commands: [commandResult(0)], outcome: "stopped" }), state())).toEqual({ ok: true });
  });

  it("has no field that is a verdict, an approval or a permission, and refuses one", () => {
    for (const extra of [{ passed: true }, { verdict: "pass" }, { approved: true }, { permissions: ["merge"] }, { model: "x" }, { editPermissions: {} }]) {
      expect(ok(RunnerResultSchema, result(extra)), JSON.stringify(extra)).toBe(false);
    }
  });

  it("keeps command results in order from zero", () => {
    expect(ok(RunnerResultSchema, result({ commands: [commandResult(1)] }))).toBe(false);
    expect(ok(RunnerResultSchema, result({ commands: [commandResult(0), commandResult(0)] }))).toBe(false);
  });

  it("takes tokens only in their 43-character base64url shape, and a heartbeat capability that is not the token", () => {
    for (const leaseToken of ["short", "T".repeat(42), "T".repeat(44), `${"T".repeat(42)}=`, `${"T".repeat(42)} `]) {
      expect(ok(RunnerLeaseSchema, lease({ leaseToken })), leaseToken).toBe(false);
      expect(ok(RunnerResultSchema, result({ leaseToken })), leaseToken).toBe(false);
    }
    expect(ok(RunnerLeaseSchema, lease({ singleUse: false }))).toBe(false);
    expect(ok(RunnerLeaseSchema, lease({ heartbeatCapability: TOKEN }))).toBe(false);
    expect(ok(RunnerLeaseSchema, lease({ heartbeatCapability: undefined }))).toBe(false);
  });
});

describe("heartbeats use their own capability and never spend the result token", () => {
  const beat = (over: Record<string, unknown> = {}) => ({ version: 1, leaseId: LEASE_ID, jobId: JOB_ID, fence: 4, heartbeatCapability: BEAT, seq: 0, sentAt: at(15), ...over });
  const record = runnerLeaseRecord(RunnerGrantSchema.parse(grant()));
  const state = (over: Partial<RunnerCheckState> = {}): RunnerCheckState => ({ redeemed: false, now: NOW + 15_000, currentFence: 4, ...over });
  const parsedBeat = (over: Record<string, unknown> = {}) => RunnerHeartbeatSchema.parse(beat(over));

  it("are strict, and carry the capability, never the result token", () => {
    expect(ok(RunnerHeartbeatSchema, beat({ commandIndex: 2 }))).toBe(true);
    expect(ok(RunnerHeartbeatSchema, beat({ seq: -1 }))).toBe(false);
    expect(ok(RunnerHeartbeatSchema, beat({ commandIndex: RUNNER_MAX_COMMANDS }))).toBe(false);
    expect(ok(RunnerHeartbeatSchema, beat({ output: "x" }))).toBe(false);
    expect(ok(RunnerHeartbeatSchema, beat({ leaseToken: TOKEN }))).toBe(false);
    expect(ok(RunnerHeartbeatSchema, beat({ heartbeatCapability: undefined }))).toBe(false);
    expect(ok(RunnerHeartbeatSchema, beat({ heartbeatCapability: "short" }))).toBe(false);
    expect(ok(RunnerHeartbeatAckSchema, { action: "continue", expiresAt: at(75) })).toBe(true);
    expect(ok(RunnerHeartbeatAckSchema, { action: "revoked" })).toBe(true);
    expect(ok(RunnerHeartbeatAckSchema, { action: "continue" })).toBe(false);
    expect(ok(RunnerHeartbeatAckSchema, { action: "run_more" })).toBe(false);
  });

  it("fails closed on a clock that is not a finite number, and on a command index the job does not have", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(checkRunnerHeartbeat(record, parsedBeat(), state({ now })), String(now)).toEqual({ ok: false, reason: "bad_clock" });
    }
    // The grant above has one command: index 0 is its own, index 1 is not.
    expect(checkRunnerHeartbeat(record, parsedBeat({ commandIndex: 0 }), state())).toEqual({ ok: true });
    expect(checkRunnerHeartbeat(record, parsedBeat({ commandIndex: 1 }), state())).toEqual({ ok: false, reason: "bad_command_index" });
    expect(checkRunnerHeartbeat(record, parsedBeat({ commandIndex: 63 }), state())).toEqual({ ok: false, reason: "bad_command_index" });
  });

  it("is accepted for its own lease, fence and time, and refused otherwise", () => {
    expect(checkRunnerHeartbeat(record, parsedBeat(), state())).toEqual({ ok: true });
    expect(checkRunnerHeartbeat(record, parsedBeat({ heartbeatCapability: "Z".repeat(43) }), state())).toEqual({ ok: false, reason: "wrong_capability" });
    // The result token is not a heartbeat capability.
    expect(checkRunnerHeartbeat(record, parsedBeat({ heartbeatCapability: TOKEN }), state())).toEqual({ ok: false, reason: "wrong_capability" });
    expect(checkRunnerHeartbeat(record, parsedBeat(), state({ currentFence: 5 }))).toEqual({ ok: false, reason: "stale_fence" });
    expect(checkRunnerHeartbeat(record, parsedBeat(), state({ redeemed: true }))).toEqual({ ok: false, reason: "already_redeemed" });
    expect(checkRunnerHeartbeat(record, parsedBeat(), state({ now: NOW - 1 }))).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(checkRunnerHeartbeat(record, parsedBeat(), state({ now: NOW + 61_000 }))).toEqual({ ok: false, reason: "expired" });
    expect(checkRunnerHeartbeat(record, parsedBeat({ jobId: OPERATION_ID }), state())).toEqual({ ok: false, reason: "wrong_job" });
    expect(checkRunnerHeartbeat(record, parsedBeat({ leaseId: OPERATION_ID }), state())).toEqual({ ok: false, reason: "wrong_lease" });
  });
});

describe("a message that cannot be read is a refusal, never a throw, and is sized before it is written out", () => {
  it("does not build the JSON text of a value that is certainly too large", () => {
    const spy = vi.spyOn(JSON, "stringify");
    try {
      const huge = { ...lease(), padding: "x".repeat(RUNNER_MESSAGE_MAX_BYTES + 1) };
      const refused = RunnerLeaseSchema.safeParse(huge);
      expect(spy).not.toHaveBeenCalled();
      const manyItems = { ...lease(), padding: new Array<number>(RUNNER_MESSAGE_MAX_BYTES).fill(1) };
      const refusedItems = RunnerLeaseSchema.safeParse(manyItems);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(refused.success).toBe(false);
      expect(refusedItems.success).toBe(false);
      expect(JSON.stringify(refused.error?.issues)).toContain("bytes");
    } finally {
      spy.mockRestore();
    }
  });

  it("turns a cycle, a BigInt, a throwing getter and absurd nesting into a refusal", () => {
    const cyclic: Record<string, unknown> = { ...lease() };
    cyclic["self"] = cyclic;
    const withBigInt = { ...lease(), padding: 10n };
    const throwing = { ...lease() };
    Object.defineProperty(throwing, "boom", { enumerable: true, get: () => { throw new TypeError("boom"); } });
    let deep: unknown = 1;
    for (let level = 0; level < 200_000; level += 1) deep = { a: deep };
    for (const [name, value] of Object.entries({ cyclic, withBigInt, throwing, deep: { ...lease(), deep } })) {
      for (const schema of [RunnerLeaseSchema, RunnerJobSchema, RunnerGrantSchema, RunnerResultSchema, RunnerHeartbeatSchema]) {
        expect(() => schema.safeParse(value), name).not.toThrow();
        expect(schema.safeParse(value).success, name).toBe(false);
      }
    }
    expect(() => findRunnerForbiddenField(deep)).not.toThrow();
  });

  it("refuses a body by its length before parsing it", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      const big = `{"a":"${"x".repeat(RUNNER_MESSAGE_MAX_BYTES)}"}`;
      const encode = vi.spyOn(TextEncoder.prototype, "encode");
      expect(readRunnerBody(big, RUNNER_MESSAGE_MAX_BYTES)).toEqual({ ok: false, reason: "too_large" });
      expect(parse).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
      encode.mockRestore();
      // Characters are not bytes: a body of 2-byte characters under the length limit can still be over the byte limit.
      expect(readRunnerBody(JSON.stringify({ a: "é".repeat(40) }), 80)).toEqual({ ok: false, reason: "too_large" });
    } finally {
      parse.mockRestore();
    }
    expect(readRunnerBody("not json", 100)).toEqual({ ok: false, reason: "not_json" });
    expect(readRunnerBody('{"a":1}', 100)).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("runner ids", () => {
  it("are short lowercase names", () => {
    expect(ok(RunnerIdSchema, "build-host_1")).toBe(true);
    for (const bad of ["", "Build", "-x", "a b", "a/b", "a:b", "a".repeat(64)]) expect(ok(RunnerIdSchema, bad), bad).toBe(false);
  });
});
