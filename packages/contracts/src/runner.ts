// Team build runner R3 (setup-test-health 10.2, task SH35): the CONTRACT of a runner's jobs, leases, heartbeats and results. Contract only: no runner, no lease endpoint and no client is built.
//
// TRUST MODEL (read this before changing anything below)
//   - A runner is CUSTOMER-HOSTED. It runs on a host the customer sanctioned (a team build host, a developer cloud host), under a service identity, outside Rovara's boundary. Rovara does not control its
//     operating system, its network or its operators.
//   - What comes back from a runner is EVIDENCE, NEVER AUTHORITY. A result says what a command printed and how it exited, as a runner claims it. The control plane decides what that is worth: it checks the
//     result against the lease it issued (`checkRunnerResult`), redacts the output, keeps it as raw evidence next to the sandbox's, and derives every verdict itself. No field of a result is a verdict, a
//     permission, an approval or an instruction, and none may become one. A result may be wrong, late, replayed or forged by whoever controls the host; it can never make a task pass or a person's gate open.
//   - THE REAL CONTROL IS WHAT A JOB CONTAINS. A job is built only from commands a person approved: a `setup_command` job is one command a person approved (bound by its digest and the approver), and every
//     other job is made only of commands of an approved test environment revision (bound by its digest; `checkRunnerJobEnvironment`). Redaction, the credential and model-access name checks and the
//     character checks below are DEFENCE IN DEPTH behind that rule, never a substitute for it. A command that is not an approved command is never sent, whatever it looks like.
//   - A PROVE OF AN UNCONFIRMED PROPOSAL IS NEVER SENT TO A RUNNER. A `prove` job names an approved revision's digest. On a runner, proving a proposal becomes a series of approved `setup_command` jobs, each a
//     command a person approved one at a time (Q10); there is no autonomous shell on a corporate host.
//   - The agent, its model calls and its edits stay CENTRAL. A runner runs build and test commands only: `setup_command`, `run_checks`, `prove`, `nightly`. A job can never carry a model credential, a
//     provider or model choice, a prompt, a tool list or an edit or write permission. Every object here is strict (an unknown field is refused) and every message is also scanned for such field names and for
//     credential-shaped environment names, so the refusal does not depend on strictness alone (`findRunnerForbiddenField`).
//   - A grant is SIGNED by the control plane's KMS signing key (the key that signs worker invocations, protocol.ts); a runner must verify the signature before it runs anything. The `signature` field is a
//     placeholder: no signer, verifier or key exists yet, and this file verifies nothing. `runnerGrantSigningInput` is the exact text that is signed.
//   - A lease is bound to one job, one runner, one fence and one deadline. Its result token is SINGLE-USE and a job id is single-use: the control plane enforces both CENTRALLY (it keeps a redeemed flag per
//     lease and refuses a second grant or second result for a jobId), and a lost lease is fenced and re-leased at most once, never run twice (enterprise-foundations plan B). The control plane keeps only the
//     SHA-256 of the result token and of the heartbeat capability (`runnerLeaseRecord`), never the values, and compares in constant time. Tokens here are SHAPES; the contract never holds a real one.
//   - HEARTBEATS use their own lease-bound capability, so the single-use result token is never spent by a heartbeat.
//   - A result's output is plain text the RUNNER prepares: it strips ANSI escape sequences and normalises CR and CRLF to LF before it sends (the schema still tolerates `\r\n`), and it keeps the last part
//     that fits. The control plane redacts it again before it keeps it.
//   - Everything is bounded: commands per job, bytes per message, output bytes per command (measured as written in JSON), the lease's lifetime. A runner cannot make the control plane read an unbounded message.
// Pure: nothing here reads a file, a clock or a network, and it imports no Node module. The caller hands in the time and the stored state.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { PROJECT_COMMAND_ENV_MAX_ENTRIES, ProjectCommandSchema } from "./project.js";
import { isCredentialKey, redactText } from "./redaction.js";
import { type TestEnvironmentBody, testEnvDigest } from "./test-environment.js";
import { sha256Hex } from "./web-hash.js";

export const RUNNER_CONTRACT_VERSION = 1;

/** The only kinds of job a runner is given. Anything else (an agent step, a publish, a model call) is refused. */
export const RUNNER_JOB_KINDS = ["setup_command", "run_checks", "prove", "nightly"] as const;
export const RunnerJobKindSchema = z.enum(RUNNER_JOB_KINDS);
export type RunnerJobKind = z.infer<typeof RunnerJobKindSchema>;

/** The id of a runner, as `runner:<id>` and `/v1/runners/{id}/lease` name it. */
export const RunnerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u, "a runner id (lowercase letters, digits, - and _, at most 63 characters)");

// ---- bounds

export const RUNNER_MAX_COMMANDS = 64;
export const RUNNER_MAX_REPOSITORIES = 16;
/** The most all of a job's command timeouts may add up to (6 hours). */
export const RUNNER_JOB_MAX_TOTAL_SECONDS = 21_600;
/** The longest a lease may live from issue to its hard deadline (8 hours). */
export const RUNNER_LEASE_MAX_SECONDS = 28_800;
export const RUNNER_HEARTBEAT_MIN_SECONDS = 5;
export const RUNNER_HEARTBEAT_MAX_SECONDS = 60;
export const RUNNER_MISSED_HEARTBEATS_MAX = 5;
/** A candidate patch is carried as a digest and a size; the bytes travel on the signed channel and are checked against both. */
export const RUNNER_PATCH_MAX_BYTES = 1_048_576;
/** The most one command's output the control plane reads: 4 KiB measured AS WRITTEN IN JSON (a newline counts two), so a result can never outgrow the bound below. */
export const RUNNER_OUTPUT_TAIL_BYTES = 4_096;
/** The most a whole grant or a whole result may be, as JSON in UTF-8. */
export const RUNNER_GRANT_MAX_BYTES = 262_144;
export const RUNNER_RESULT_MAX_BYTES = 327_680;
export const RUNNER_MESSAGE_MAX_BYTES = 65_536;
/**
 * The most object keys a message of the largest shape can hold: every command's own fields and its environment names, plus a margin for the envelope. Derived from the bounds above, so raising a
 * bound raises the cap with it. Only keys are counted: array items are bounded by the message's byte limit, which is checked first.
 */
export const RUNNER_SCAN_MAX_KEYS = RUNNER_MAX_COMMANDS * (6 + PROJECT_COMMAND_ENV_MAX_ENTRIES) + RUNNER_MAX_REPOSITORIES * 2 + 256;
const SCAN_MAX_DEPTH = 12;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u, "a sha256 in lowercase hex");
const GitCommit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, "a git commit id in lowercase hex");
const RepositoryId = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}\s]+$/u, "an id has no whitespace or control characters");
const PersonId = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}\s]+$/u, "a person id has no whitespace or control characters");
const Timestamp = z.string().datetime();
/** 256 bits as base64url. The SHAPE of a single-use result token; the contract never holds a real one. */
export const RunnerLeaseTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "a lease token (43 base64url characters)");
/** The SHAPE of the lease-bound capability a heartbeat presents instead of the result token. */
export const RunnerHeartbeatCapabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "a heartbeat capability (43 base64url characters)");

// ---- fields a job can never carry

/** Names (lowercase letters and digits only) that no field of a job may contain: model credentials and choices, prompts and tools, edit and write permissions. */
const FORBIDDEN_FIELD_PARTS = [
  "model", "prompt", "provider", "bedrock", "anthropic", "openai", "apikey", "credential", "secret", "password", "passwd", "bearer", "authorization", "privatekey", "accesskey", "sessiontoken",
  "tool", "edit", "write", "permission", "privilege", "sudo", "grant",
] as const;
/** Words that no environment variable name may contain (lowercased): model access of any provider. */
const FORBIDDEN_ENV_WORDS = ["anthropic", "openai", "bedrock", "claude", "gemini", "vertex", "sagemaker", "model", "prompt", "provider"] as const;
/** Environment names a command may not start with: model access, cloud credentials, the code host's and Rovara's own. */
const FORBIDDEN_ENV_PREFIXES = ["ANTHROPIC_", "OPENAI_", "AWS_", "AZURE_", "GOOGLE_", "GEMINI_", "MISTRAL_", "COHERE_", "BEDROCK_", "AGENTX_", "ROVARA_", "CLAUDE_", "GH_", "GIT_CONFIG", "GIT_ASKPASS", "SSH_"] as const;
const FORBIDDEN_ENV_SUFFIXES = ["_PAT", "_DSN"] as const;

function forbiddenFieldName(name: string): boolean {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return isCredentialKey(name) || FORBIDDEN_FIELD_PARTS.some((part) => flat.includes(part));
}

/** Whether a command may not set this environment variable. This is the DEFENCE; the rule is the allow-list of the approved environment's own names (`checkRunnerJobEnvironment`). */
export function forbiddenRunnerEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  const lower = name.toLowerCase();
  return isCredentialKey(name)
    || FORBIDDEN_ENV_WORDS.some((word) => lower.includes(word))
    || FORBIDDEN_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
    || FORBIDDEN_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

export type RunnerScanFinding = { path: string; reason: "forbidden" | "too_many_fields" | "too_deep" };

/**
 * The first problem in `value` that a runner message may not have, or undefined: a field a job may not carry (names are checked everywhere except directly under an `env` object, whose names are checked as
 * environment names), more object keys than the largest valid message holds, or nesting that is too deep. `allowed` lists the dot-joined paths of the fields allowed to look like credentials: the tokens.
 */
export function findRunnerForbiddenField(value: unknown, allowed: readonly string[] = []): RunnerScanFinding | undefined {
  let keys = 0;
  const visit = (node: unknown, path: string[], underEnv: boolean): RunnerScanFinding | undefined => {
    if (path.length > SCAN_MAX_DEPTH) return { path: path.join("."), reason: "too_deep" };
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const found = visit(node[index], [...path, String(index)], false);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (node === null || typeof node !== "object") return undefined;
    for (const key of Object.keys(node)) {
      const here = [...path, key];
      keys += 1;
      if (keys > RUNNER_SCAN_MAX_KEYS) return { path: here.join("."), reason: "too_many_fields" };
      if (key === "__proto__") return { path: here.join("."), reason: "forbidden" };
      if (!allowed.includes(here.join(".")) && (underEnv ? forbiddenRunnerEnvName(key) : forbiddenFieldName(key))) return { path: here.join("."), reason: "forbidden" };
      const found = visit((node as Record<string, unknown>)[key], here, key === "env");
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(value, [], false);
}

const SIZE_WALK_MAX_DEPTH = 64;

/**
 * Whether `raw` is certainly larger than `maxBytes` as JSON, found by a walk that adds up a LOWER bound of its size (a string is at least its length in bytes, a key its length plus 3, a value 1) and stops the moment
 * the bound is passed or the nesting is deeper than any message can be. It never builds the JSON text, so it costs at most about `maxBytes` of work however large or deep the value is, and cannot overflow the stack.
 */
function certainlyOverBytes(raw: unknown, maxBytes: number): boolean {
  let bound = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > SIZE_WALK_MAX_DEPTH) return true;
    if (typeof node === "string") bound += node.length + 2;
    else if (Array.isArray(node)) {
      bound += 2;
      for (const item of node) {
        bound += 1;
        if (bound > maxBytes || visit(item, depth + 1)) return true;
      }
    } else if (node !== null && typeof node === "object") {
      bound += 2;
      for (const key of Object.keys(node)) {
        bound += key.length + 4;
        if (bound > maxBytes || visit((node as Record<string, unknown>)[key], depth + 1)) return true;
      }
    } else bound += 1;
    return bound > maxBytes;
  };
  return visit(raw, 0);
}

/**
 * Runs before the shape is read: the byte bound first (a walk that never builds the JSON text, then the exact size), then the forbidden fields, each with its own sentence. The whole function is guarded: a value
 * that cannot be read (a cycle, a BigInt, a getter that throws, nesting that overflows the stack) is a refusal, never a throw.
 */
const refuseUnsafeMessage = (allowed: readonly string[], maxBytes: number) => (raw: unknown, context: z.RefinementCtx): void => {
  try {
    if (certainlyOverBytes(raw, maxBytes) || utf8Bytes(JSON.stringify(raw) ?? "") > maxBytes) {
      context.addIssue({ code: "custom", message: `a runner message is at most ${String(maxBytes)} bytes` });
      return;
    }
    const found = findRunnerForbiddenField(raw, allowed);
    if (found === undefined) return;
    context.addIssue({
      code: "custom",
      message: found.reason === "forbidden"
        ? `a runner job or result may not carry ${found.path}: model credentials, edit permissions and secrets stay central`
        : found.reason === "too_many_fields" ? `a runner message has more fields than the largest valid message (${String(RUNNER_SCAN_MAX_KEYS)}), at ${found.path}` : `a runner message is nested too deeply, at ${found.path}`,
    });
  } catch {
    context.addIssue({ code: "custom", message: "a runner message could not be read" });
  }
};

/**
 * Reads a message body as it arrived (text): refused by its length BEFORE it is parsed when it cannot fit (a body's length in characters is at most its size in bytes), then parsed. The caller then hands the value to
 * the schema of its message. `limit` is the message's own byte bound: a grant `RUNNER_GRANT_MAX_BYTES`, a result `RUNNER_RESULT_MAX_BYTES`, a lease or heartbeat `RUNNER_MESSAGE_MAX_BYTES`.
 */
export function readRunnerBody(body: string, limit: number): { ok: true; value: unknown } | { ok: false; reason: "too_large" | "not_json" } {
  if (typeof body !== "string" || body.length > limit || utf8Bytes(body) > limit) return { ok: false, reason: "too_large" };
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, reason: "not_json" };
  }
}

// ---- commands

/** Zero-width, bidi and other format characters (Unicode Cf) hide text from a person reading a command, and control characters (ESC, CR, LF, NUL ...) rewrite what a terminal or log shows. */
const HAS_HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;

/** A command as a runner is given it: the project's command, with no credential-shaped environment name or value, no credential-shaped argument and no hidden characters. */
export const RunnerCommandSchema = ProjectCommandSchema.superRefine((command, context) => {
  const text = [command.cwd, command.executable, ...command.args, ...Object.values(command.env ?? {})];
  if (text.some((item) => HAS_HIDDEN_CHARACTER.test(item))) context.addIssue({ code: "custom", message: "a runner command may not carry control characters or zero-width, bidirectional or other format characters" });
  if (text.some((item) => redactText(item) !== item)) context.addIssue({ code: "custom", message: "a runner command may not carry a credential" });
  if (Object.keys(command.env ?? {}).some(forbiddenRunnerEnvName)) context.addIssue({ code: "custom", path: ["env"], message: "a runner command may not set a credential or model-access variable" });
});
export type RunnerCommand = z.infer<typeof RunnerCommandSchema>;

/** The digest a person's approval of one command is bound to: sha256 of the command's canonical JSON (executable, arguments, directory, timeout and environment). */
export function runnerCommandDigest(command: z.input<typeof ProjectCommandSchema>): string {
  return sha256Hex(canonicalJson(ProjectCommandSchema.parse(command)));
}

// ---- the job

export const RunnerWorkspacePinSchema = z.object({
  /** One entry per repository, each at the commit the central worker resolved. The runner clones it with its own identity. */
  repositories: z.array(z.object({ repositoryId: RepositoryId, commit: GitCommit }).strict()).min(1).max(RUNNER_MAX_REPOSITORIES),
  /** The test environment's revision the commands come from. */
  envRevision: z.number().int().min(1),
  /** The environment key (saved-env.ts) a runner's own workspace cache is keyed by. */
  environmentKey: Sha256Hex.optional(),
}).strict().superRefine((pin, context) => {
  const seen = new Set<string>();
  for (const [index, repository] of pin.repositories.entries()) {
    if (seen.has(repository.repositoryId)) context.addIssue({ code: "custom", path: ["repositories", index, "repositoryId"], message: "a repository is pinned twice" });
    seen.add(repository.repositoryId);
  }
});
export type RunnerWorkspacePin = z.infer<typeof RunnerWorkspacePinSchema>;

const CandidatePatchSchema = z.object({
  repositoryId: RepositoryId,
  sha256: Sha256Hex,
  sizeBytes: z.number().int().min(1).max(RUNNER_PATCH_MAX_BYTES),
}).strict();

const JobBase = {
  version: z.literal(RUNNER_CONTRACT_VERSION),
  jobId: z.string().uuid(),
  workspace: RunnerWorkspacePinSchema,
  /** The code to check on top of the pinned commit, as a digest and size; absent when the pinned commit is the code. */
  candidatePatch: CandidatePatchSchema.optional(),
};
const Commands = z.array(RunnerCommandSchema).min(1).max(RUNNER_MAX_COMMANDS);

const JobObjectSchema = z.discriminatedUnion("kind", [
  // One command a person approved in setup mode (Q10). No autonomous shell on a corporate host. The approval is bound to the command by its digest.
  z.object({ ...JobBase, kind: z.literal("setup_command"), commands: Commands.max(1), personApprovalId: z.string().uuid(), approvedBy: PersonId, approvedCommandSha256: Sha256Hex }).strict(),
  // Every other job is made only of commands of an approved environment revision, named by its digest (testEnvDigest).
  z.object({ ...JobBase, kind: z.literal("run_checks"), commands: Commands, environmentDigest: Sha256Hex }).strict(),
  z.object({ ...JobBase, kind: z.literal("prove"), commands: Commands, environmentDigest: Sha256Hex }).strict(),
  z.object({ ...JobBase, kind: z.literal("nightly"), commands: Commands, environmentDigest: Sha256Hex }).strict(),
]);

function checkJob(job: z.infer<typeof JobObjectSchema>, context: z.RefinementCtx): void {
  const total = job.commands.reduce((sum, command) => sum + command.timeoutSeconds, 0);
  if (total > RUNNER_JOB_MAX_TOTAL_SECONDS) context.addIssue({ code: "custom", path: ["commands"], message: `a job's command timeouts add up to at most ${String(RUNNER_JOB_MAX_TOTAL_SECONDS)} seconds` });
  if (job.candidatePatch !== undefined && !job.workspace.repositories.some((repository) => repository.repositoryId === job.candidatePatch?.repositoryId)) {
    context.addIssue({ code: "custom", path: ["candidatePatch", "repositoryId"], message: "the patch is for a repository the job does not pin" });
  }
  if (job.kind === "setup_command" && job.commands[0] !== undefined && runnerCommandDigest(job.commands[0]) !== job.approvedCommandSha256) {
    context.addIssue({ code: "custom", path: ["approvedCommandSha256"], message: "the approved digest is not the digest of the command" });
  }
}

/** One job, strict by kind. A kind that is not one of the four is refused. */
export const RunnerJobSchema = z.unknown().superRefine(refuseUnsafeMessage([], RUNNER_GRANT_MAX_BYTES)).pipe(JobObjectSchema).superRefine(checkJob);
export type RunnerJob = z.infer<typeof JobObjectSchema>;

/** The digest a result echoes to say which job it ran: sha256 of the job's canonical JSON. */
export function runnerJobDigest(job: RunnerJob): string {
  return sha256Hex(canonicalJson(job));
}

/**
 * Whether a non-setup job is made only of an approved environment's commands, given the approved environment (its revision and body; the control plane reads it by `job.environmentDigest`). Pure. In order:
 *   - the body's digest is the job's, and the revision is the one the workspace pin names;
 *   - the pin names exactly the environment's repositories;
 *   - every environment variable name is one the environment itself names (the allow-list; the name checks above are only the defence);
 *   - every command is exactly one of the commands its KIND may carry (canonical JSON, so the arguments, directory, timeout and environment all match): `run_checks` carries check commands only, never a
 *     setup command; `prove` and `nightly` carry setup and check commands;
 *   - no command is listed twice.
 * A `setup_command` job is checked by its approval digest instead.
 */
export function checkRunnerJobEnvironment(job: RunnerJob, approved: { revision: number; environment: TestEnvironmentBody }): { ok: true } | { ok: false; reason: RunnerEnvironmentRefusal } {
  if (job.kind === "setup_command") return { ok: false, reason: "not_an_environment_job" };
  const environment = approved.environment;
  if (testEnvDigest(environment) !== job.environmentDigest) return { ok: false, reason: "wrong_environment" };
  if (approved.revision !== job.workspace.envRevision) return { ok: false, reason: "wrong_revision" };
  const pinned = job.workspace.repositories.map((repository) => repository.repositoryId).sort();
  const owned = environment.repos.map((repo) => repo.repositoryId).sort();
  if (pinned.length !== owned.length || pinned.some((id, at) => id !== owned[at])) return { ok: false, reason: "wrong_repositories" };
  const setupCommands = environment.repos.flatMap((repo) => repo.setupCommands);
  const checkCommands = environment.repos.flatMap((repo) => repo.checks.map((check) => check.command));
  const everyForm = new Set([...setupCommands, ...checkCommands].map((command) => canonicalJson(command)));
  const allowedForms = new Set((job.kind === "run_checks" ? checkCommands : [...setupCommands, ...checkCommands]).map((command) => canonicalJson(command)));
  const approvedNames = new Set([...setupCommands, ...checkCommands].flatMap((command) => Object.keys(command.env ?? {})));
  const seen = new Set<string>();
  for (const command of job.commands) {
    if (Object.keys(command.env ?? {}).some((name) => !approvedNames.has(name))) return { ok: false, reason: "env_name_not_in_environment" };
    const form = canonicalJson(command);
    if (!everyForm.has(form)) return { ok: false, reason: "command_not_in_environment" };
    if (!allowedForms.has(form)) return { ok: false, reason: "command_not_allowed_for_kind" };
    if (seen.has(form)) return { ok: false, reason: "duplicate_command" };
    seen.add(form);
  }
  return { ok: true };
}

export type RunnerEnvironmentRefusal =
  | "not_an_environment_job" | "wrong_environment" | "wrong_revision" | "wrong_repositories" | "env_name_not_in_environment" | "command_not_in_environment" | "command_not_allowed_for_kind" | "duplicate_command";

// ---- the lease

const LeaseObjectSchema = z.object({
  leaseId: z.string().uuid(),
  jobId: z.string().uuid(),
  runnerId: RunnerIdSchema,
  /** The invocation's operation and fence (enterprise-foundations): a stale fence is refused, so a job is never run twice. */
  operationId: z.string().uuid(),
  fence: z.number().int().positive(),
  issuedAt: Timestamp,
  /** When the lease lapses unless a heartbeat is accepted; each accepted heartbeat moves it forward, never past the hard deadline. */
  expiresAt: Timestamp,
  hardDeadlineAt: Timestamp,
  heartbeat: z.object({
    intervalSeconds: z.number().int().min(RUNNER_HEARTBEAT_MIN_SECONDS).max(RUNNER_HEARTBEAT_MAX_SECONDS),
    /** Heartbeats that may be missed before the lease lapses. */
    missedAllowed: z.number().int().min(1).max(RUNNER_MISSED_HEARTBEATS_MAX),
  }).strict(),
  /** Redeemed by the first accepted result; a second use is refused (the control plane keeps a redeemed flag per lease and per job id). */
  singleUse: z.literal(true),
  leaseToken: RunnerLeaseTokenSchema,
  /** What the runner's heartbeats present. Separate from the result token, so heartbeating never spends it. */
  heartbeatCapability: RunnerHeartbeatCapabilitySchema,
}).strict();
export type RunnerLease = z.infer<typeof LeaseObjectSchema>;

function checkLease(lease: RunnerLease, context: z.RefinementCtx): void {
  const issued = Date.parse(lease.issuedAt);
  const expires = Date.parse(lease.expiresAt);
  const hard = Date.parse(lease.hardDeadlineAt);
  if (!(issued < expires)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "a lease expires after it is issued" });
  if (!(expires <= hard)) context.addIssue({ code: "custom", path: ["hardDeadlineAt"], message: "the hard deadline is not before the expiry" });
  if (hard - issued > RUNNER_LEASE_MAX_SECONDS * 1000) context.addIssue({ code: "custom", path: ["hardDeadlineAt"], message: `a lease lives at most ${String(RUNNER_LEASE_MAX_SECONDS)} seconds` });
  if (lease.leaseToken === lease.heartbeatCapability) context.addIssue({ code: "custom", path: ["heartbeatCapability"], message: "the heartbeat capability is not the result token" });
}
export const RunnerLeaseSchema = z.unknown().superRefine(refuseUnsafeMessage(["leaseToken", "heartbeatCapability"], RUNNER_MESSAGE_MAX_BYTES)).pipe(LeaseObjectSchema).superRefine(checkLease);

/** The signature on a grant: PLACEHOLDER. The required signer is the control plane's KMS signing key; no signer or verifier exists yet. */
export const RUNNER_GRANT_SIGNER = "rovara-control-plane-kms";
export const RunnerGrantSignatureSchema = z.object({
  signer: z.literal(RUNNER_GRANT_SIGNER),
  algorithm: z.literal("ECDSA_SHA_256"),
  keyId: z.string().regex(/^[A-Za-z0-9:/_.-]{1,2048}$/u, "a key id"),
  /** Base64 of the signature over `runnerGrantSigningInput`. */
  value: z.string().regex(/^[A-Za-z0-9+/]{1,1024}={0,2}$/u, "a base64 signature"),
}).strict();

/** What the long-poll hands a runner: the lease and the job it is for, signed. */
export const RunnerGrantSchema = z.unknown()
  .superRefine(refuseUnsafeMessage(["lease.leaseToken", "lease.heartbeatCapability"], RUNNER_GRANT_MAX_BYTES))
  .pipe(z.object({ version: z.literal(RUNNER_CONTRACT_VERSION), lease: LeaseObjectSchema, job: JobObjectSchema, signature: RunnerGrantSignatureSchema }).strict())
  .superRefine((grant, context) => {
    checkLease(grant.lease, context);
    checkJob(grant.job, context);
    if (grant.lease.jobId !== grant.job.jobId) context.addIssue({ code: "custom", path: ["lease", "jobId"], message: "the lease is for another job" });
    const total = grant.job.commands.reduce((sum, command) => sum + command.timeoutSeconds, 0);
    if (total * 1000 > Date.parse(grant.lease.hardDeadlineAt) - Date.parse(grant.lease.issuedAt)) context.addIssue({ code: "custom", path: ["lease", "hardDeadlineAt"], message: "the commands' timeouts do not fit in the lease" });
  });
export type RunnerGrant = z.infer<typeof RunnerGrantSchema>;

/** The exact text the grant's signature covers: the version, the lease and the job, in canonical JSON, without the signature. */
export function runnerGrantSigningInput(grant: Pick<RunnerGrant, "version" | "lease" | "job">): string {
  return canonicalJson({ version: grant.version, lease: grant.lease, job: grant.job });
}

/** What the control plane STORES of an issued grant: everything but the two secrets, whose SHA-256 it keeps instead. */
export type RunnerLeaseRecord = {
  lease: Omit<RunnerLease, "leaseToken" | "heartbeatCapability">;
  job: RunnerJob;
  leaseTokenSha256: string;
  heartbeatCapabilitySha256: string;
};

export function runnerLeaseRecord(grant: Pick<RunnerGrant, "lease" | "job">): RunnerLeaseRecord {
  const { leaseToken, heartbeatCapability, ...lease } = grant.lease;
  return { lease, job: grant.job, leaseTokenSha256: sha256Hex(leaseToken), heartbeatCapabilitySha256: sha256Hex(heartbeatCapability) };
}

/** Compares two equal-length hex digests without stopping at the first difference. */
function sameDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

// ---- heartbeat

export const RunnerHeartbeatSchema = z.unknown().superRefine(refuseUnsafeMessage(["heartbeatCapability"], RUNNER_MESSAGE_MAX_BYTES)).pipe(z.object({
  version: z.literal(RUNNER_CONTRACT_VERSION),
  leaseId: z.string().uuid(),
  jobId: z.string().uuid(),
  fence: z.number().int().positive(),
  /** Authenticates the heartbeat to its lease. NOT the result token. */
  heartbeatCapability: RunnerHeartbeatCapabilitySchema,
  /** 0, 1, 2 ...: a repeated or older number is ignored. */
  seq: z.number().int().min(0).max(1_000_000),
  sentAt: Timestamp,
  /** The command in progress, by its place in the job. */
  commandIndex: z.number().int().min(0).max(RUNNER_MAX_COMMANDS - 1).optional(),
}).strict());
export type RunnerHeartbeat = z.infer<typeof RunnerHeartbeatSchema>;

/** The control plane's answer: keep going, or stop. `continue` carries the new expiry. */
export const RunnerHeartbeatAckSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue"), expiresAt: Timestamp }).strict(),
  z.object({ action: z.enum(["cancel", "revoked", "expired"]) }).strict(),
]);
export type RunnerHeartbeatAck = z.infer<typeof RunnerHeartbeatAckSchema>;

/** What the control plane knows when a message arrives: the clock and the current fence for the operation. The lease's redeemed flag is the caller's, kept centrally. */
export interface RunnerCheckState { redeemed: boolean; now: number; currentFence: number }

export type RunnerHeartbeatRefusal = "bad_clock" | "bad_command_index" | "stale_fence" | "not_yet_valid" | "expired" | "wrong_job" | "wrong_lease" | "wrong_capability" | "already_redeemed";

/** Whether a heartbeat belongs to the lease a record describes, is within its life and carries its capability. Does not touch the result token. */
export function checkRunnerHeartbeat(record: RunnerLeaseRecord, beat: RunnerHeartbeat, state: RunnerCheckState): { ok: true } | { ok: false; reason: RunnerHeartbeatRefusal } {
  // Fail closed: a clock that is not a number would make every time comparison false, which reads as "within the lease".
  if (!Number.isFinite(state.now)) return { ok: false, reason: "bad_clock" };
  if (state.redeemed) return { ok: false, reason: "already_redeemed" };
  if (beat.fence !== state.currentFence || record.lease.fence !== state.currentFence) return { ok: false, reason: "stale_fence" };
  if (state.now < Date.parse(record.lease.issuedAt)) return { ok: false, reason: "not_yet_valid" };
  if (state.now > Date.parse(record.lease.hardDeadlineAt) || state.now > Date.parse(record.lease.expiresAt)) return { ok: false, reason: "expired" };
  if (beat.jobId !== record.job.jobId) return { ok: false, reason: "wrong_job" };
  if (beat.leaseId !== record.lease.leaseId) return { ok: false, reason: "wrong_lease" };
  if (!sameDigest(sha256Hex(beat.heartbeatCapability), record.heartbeatCapabilitySha256)) return { ok: false, reason: "wrong_capability" };
  if (beat.commandIndex !== undefined && beat.commandIndex >= record.job.commands.length) return { ok: false, reason: "bad_command_index" };
  return { ok: true };
}

// ---- result

/** Plain text: no control character except newline, tab and carriage return, and no format character. */
const PLAIN_TEXT = /[^\P{Cc}\n\t\r]|\p{Cf}/u;

export const RunnerCommandResultSchema = z.object({
  /** The command's place in the job. */
  index: z.number().int().min(0).max(RUNNER_MAX_COMMANDS - 1),
  /** Raw facts as the runner saw them. A verdict is made centrally from these. */
  exitCode: z.number().int().min(0).max(255).nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().min(0).max(RUNNER_LEASE_MAX_SECONDS * 1000),
  /** The last part of what the command printed (stdout and stderr), plain text, at most 4 KiB AS WRITTEN IN JSON. The runner strips ANSI and normalises CR first. The control plane redacts it again. */
  outputTail: z.string().max(RUNNER_OUTPUT_TAIL_BYTES)
    .refine((text) => utf8Bytes(JSON.stringify(text)) - 2 <= RUNNER_OUTPUT_TAIL_BYTES, "output tail is over 4096 bytes as written in JSON")
    .refine((text) => !PLAIN_TEXT.test(text), "output tail is plain text (no control or format characters)"),
  /** Whether the runner cut the output to fit. */
  outputCut: z.boolean(),
}).strict();

const ResultObjectSchema = z.object({
  version: z.literal(RUNNER_CONTRACT_VERSION),
  jobId: z.string().uuid(),
  leaseId: z.string().uuid(),
  runnerId: RunnerIdSchema,
  fence: z.number().int().positive(),
  kind: RunnerJobKindSchema,
  /** sha256 of the job's canonical JSON (`runnerJobDigest`): says WHICH job this ran, so a result cannot be moved to another job with the same ids. */
  jobDigest: Sha256Hex,
  /** The pin the runner says it ran at. The control plane compares it to the job's; a difference voids the result. */
  workspace: RunnerWorkspacePinSchema,
  /** `finished`: every command ran. `stopped`: the runner stopped after a failure or a cancel. `infrastructure`: the host could not run the job (no result about the code). */
  outcome: z.enum(["finished", "stopped", "infrastructure"]),
  commands: z.array(RunnerCommandResultSchema).max(RUNNER_MAX_COMMANDS),
  finishedAt: Timestamp,
  /** Redeems the lease token. */
  leaseToken: RunnerLeaseTokenSchema,
}).strict();
export type RunnerResult = z.infer<typeof ResultObjectSchema>;

export const RunnerResultSchema = z.unknown()
  .superRefine(refuseUnsafeMessage(["leaseToken"], RUNNER_RESULT_MAX_BYTES))
  .pipe(ResultObjectSchema)
  .superRefine((result, context) => {
    result.commands.forEach((command, at) => {
      if (command.index !== at) context.addIssue({ code: "custom", path: ["commands", at, "index"], message: "command results are in order, from 0, with no gaps" });
    });
  });

export type RunnerResultRefusal =
  | "bad_clock" | "already_redeemed" | "stale_fence" | "not_yet_valid" | "expired" | "finished_outside_lease"
  | "wrong_job" | "wrong_lease" | "wrong_runner" | "wrong_job_digest" | "wrong_token" | "wrong_workspace" | "too_many_commands" | "incomplete";

/**
 * Whether a parsed result answers a lease the control plane issued (its stored record), now: not already redeemed, the fence still current, within the lease's life (issued, and not past the hard deadline),
 * same job, lease, runner, kind, job digest, token and pin, no result for a command the job does not have, and a `finished` result holds every command. The token is compared as sha256(token) against the
 * stored hash, without stopping at the first difference. Returns fixed words, never the runner's. This is the check that keeps a result evidence: it binds the claim to the lease. It does not make any claim true.
 */
export function checkRunnerResult(record: RunnerLeaseRecord, result: RunnerResult, state: RunnerCheckState): { ok: true } | { ok: false; reason: RunnerResultRefusal } {
  if (!Number.isFinite(state.now)) return { ok: false, reason: "bad_clock" };
  if (state.redeemed) return { ok: false, reason: "already_redeemed" };
  if (result.fence !== state.currentFence || record.lease.fence !== state.currentFence) return { ok: false, reason: "stale_fence" };
  if (state.now < Date.parse(record.lease.issuedAt)) return { ok: false, reason: "not_yet_valid" };
  if (state.now > Date.parse(record.lease.hardDeadlineAt)) return { ok: false, reason: "expired" };
  // When the runner says it finished must fall inside the lease it was given (a malformed time is not inside it).
  const finished = Date.parse(result.finishedAt);
  if (!(finished >= Date.parse(record.lease.issuedAt) && finished <= Date.parse(record.lease.hardDeadlineAt))) return { ok: false, reason: "finished_outside_lease" };
  if (result.jobId !== record.job.jobId) return { ok: false, reason: "wrong_job" };
  if (result.leaseId !== record.lease.leaseId || result.kind !== record.job.kind) return { ok: false, reason: "wrong_lease" };
  if (result.runnerId !== record.lease.runnerId) return { ok: false, reason: "wrong_runner" };
  if (!sameDigest(result.jobDigest, runnerJobDigest(record.job))) return { ok: false, reason: "wrong_job_digest" };
  if (!sameDigest(sha256Hex(result.leaseToken), record.leaseTokenSha256)) return { ok: false, reason: "wrong_token" };
  if (canonicalJson(result.workspace) !== canonicalJson(record.job.workspace)) return { ok: false, reason: "wrong_workspace" };
  if (result.commands.length > record.job.commands.length) return { ok: false, reason: "too_many_commands" };
  if (result.outcome === "finished" && result.commands.length !== record.job.commands.length) return { ok: false, reason: "incomplete" };
  return { ok: true };
}
