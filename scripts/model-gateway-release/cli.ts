// CLI entry point for Code's model gateway release steps (#1578).
//   npx tsx scripts/model-gateway-release/cli.ts <beta|production> <image|deploy|check|last-good|rollback-plan> [flags]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_GATEWAY_DEFAULT_REGION, MODEL_GATEWAY_ENVIRONMENTS, MODEL_GATEWAY_LAST_GOOD_PARAMETER } from "./context.js";
import { checkStep } from "./check-step.js";
import { deployStep } from "./deploy-step.js";
import { judgeDigest, judgeGatewayCodeSha, loadFloors } from "./floors.js";
import { imageStep } from "./image-step.js";
import { readLastGood, recordedGateways } from "./lastgood.js";
import { createRealPorts } from "./ports.js";
import { EXIT, StageError } from "./types.js";
import type { GatewayManifest, GatewayStepName, PipelineEnv, PipelineMode, Ports } from "./types.js";

const STEPS = ["image", "deploy", "check", "last-good", "rollback-plan"] as const;
type CliStep = (typeof STEPS)[number];
const SHA40 = /^[0-9a-f]{40}$/u;

export const USAGE = `usage: npx tsx scripts/model-gateway-release/cli.ts <beta|production> <image|deploy|check|last-good|rollback-plan> [flags]
flags (env var): --exec-id (EXEC_ID) --manifest (PIPELINE_MANIFEST) --out (PIPELINE_OUT, default out)
  --code-sha (CODE_SHA) --code-live-sha (CODE_LIVE_SHA) --code-release run|skip (CODE_RELEASE)
  --mode release|adopt|rollback (PIPELINE_MODE) --code-target <sha|none> (CODE_ROLLBACK_TARGET)
  --gateway-digest <sha256:...|none> (MODEL_GATEWAY_DIGEST) --expected-account (ROVARA_EXPECTED_DEPLOY_ACCOUNT)
  --beta-account (BETA_ACCOUNT_ID) --gateway-url (MODEL_GATEWAY_URL) --dry-run (PIPELINE_DRY_RUN=1)
`;

const VALUE_FLAGS = [
  "exec-id", "manifest", "out", "code-sha", "code-live-sha", "code-release",
  "mode", "code-target", "gateway-digest", "expected-account", "beta-account", "gateway-url",
];
const BOOLEAN_FLAGS = ["dry-run", "help"];

export interface ParsedCli {
  env: PipelineEnv;
  step: CliStep;
  flags: Record<string, string | true>;
}

function consumeFlag(argv: readonly string[], index: number, flags: Record<string, string | true>): number {
  const name = argv[index]!.slice(2);
  if (BOOLEAN_FLAGS.includes(name)) {
    flags[name] = true;
    return index;
  }
  if (!VALUE_FLAGS.includes(name)) throw new StageError("USAGE", `unknown flag --${name}`);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new StageError("USAGE", `--${name} needs a value`);
  flags[name] = value;
  return index + 1;
}

export function parseArgs(argv: readonly string[]): ParsedCli {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) positional.push(arg);
    else i = consumeFlag(argv, i, flags);
  }
  if (flags.help === true) throw new StageError("USAGE", "help");
  const [env, step, extra] = positional;
  if (extra !== undefined || env === undefined || step === undefined) throw new StageError("USAGE", "give an environment and a step");
  if (!(MODEL_GATEWAY_ENVIRONMENTS as readonly string[]).includes(env)) throw new StageError("USAGE", `unknown environment ${env}`);
  if (!(STEPS as readonly string[]).includes(step)) throw new StageError("USAGE", `unknown step ${step}`);
  return { env: env as PipelineEnv, step: step as CliStep, flags };
}

function pickValue(flags: Record<string, string | true>, env: Record<string, string | undefined>, flag: string, envName: string): string | null {
  const v = flags[flag] !== undefined && flags[flag] !== true ? flags[flag] : env[envName];
  return v === undefined || v === "" ? null : v;
}

function parseMode(raw: string | null): PipelineMode {
  const mode = raw ?? "release";
  if (mode !== "release" && mode !== "adopt" && mode !== "rollback") {
    throw new StageError("USAGE", `PIPELINE_MODE must be release, adopt or rollback, got ${mode}`);
  }
  return mode;
}

function parseCodeRelease(raw: string | null): "run" | "skip" {
  const value = raw ?? "run";
  if (value !== "run" && value !== "skip") throw new StageError("USAGE", `CODE_RELEASE must be run or skip, got ${value}`);
  return value;
}

function readManifestFile(ports: Ports, path: string | null, required: boolean): GatewayManifest | null {
  if (path === null) {
    if (required) throw new StageError("REFUSED", "PIPELINE_MANIFEST is required for this step");
    return null;
  }
  if (!ports.fs.exists(path)) throw new StageError("REFUSED", `manifest file does not exist: ${path}`);
  const parsed = JSON.parse(ports.fs.readText(path)) as GatewayManifest;
  if (parsed.schema !== 1) throw new StageError("REFUSED", "manifest has no schema 1");
  return parsed;
}

async function runReadOnly(step: "last-good" | "rollback-plan", env: PipelineEnv, ports: Ports, repoDir: string, out: (line: string) => void): Promise<number> {
  const record = await readLastGood(ports, env);
  if (step === "last-good") {
    out(record === null ? "none" : JSON.stringify(record, null, 2));
    return EXIT.OK;
  }
  const entries = recordedGateways(record);
  if (entries.length === 0) {
    out(`no model gateway last-good record in ${MODEL_GATEWAY_LAST_GOOD_PARAMETER[env]}`);
    return EXIT.ROLLBACK_REFUSED;
  }
  const floors = loadFloors(ports);
  for (const entry of entries) {
    const digestProblems = judgeDigest(floors, entry.digest);
    const shaProblems = entry.codeSha === null ? [] : (await judgeGatewayCodeSha(ports, floors, repoDir, entry.codeSha)).failures;
    const problems = [...digestProblems, ...shaProblems];
    out(`${entry.which}: MODEL_GATEWAY_DIGEST=${entry.digest} CODE_ROLLBACK_TARGET=${entry.codeSha ?? "none"}${problems.length === 0 ? " (allowed)" : ` (BLOCKED: ${problems.join("; ")})`}`);
  }
  return EXIT.OK;
}

export interface CliDeps {
  makePorts?: (args: { region: string; exec8: string; profile: string | null }) => Ports;
  out?: (line: string) => void;
  repoDir?: string;
}

function optionalNone(value: string | null): string | null {
  return value === null || value === "none" ? null : value;
}

interface RunConfig {
  execId: string;
  mode: PipelineMode;
  codeRelease: "run" | "skip";
  codeSha: string;
  codeLiveSha: string | null;
  codeRollbackTarget: string | null;
  gatewayDigest: string | null;
  expectedAccount: string;
  betaAccountId: string | null;
  region: string;
  dryRun: boolean;
  outDir: string;
  manifestPath: string | null;
  workDir: string;
  gatewayUrlOverride: string | null;
}

function readRunConfig(flags: Record<string, string | true>, envVars: Record<string, string | undefined>): RunConfig {
  const execId = pickValue(flags, envVars, "exec-id", "EXEC_ID");
  if (execId === null) throw new StageError("USAGE", "EXEC_ID is not set");
  return {
    execId,
    mode: parseMode(pickValue(flags, envVars, "mode", "PIPELINE_MODE")),
    codeRelease: parseCodeRelease(pickValue(flags, envVars, "code-release", "CODE_RELEASE")),
    codeSha: pickValue(flags, envVars, "code-sha", "CODE_SHA") ?? "",
    codeLiveSha: pickValue(flags, envVars, "code-live-sha", "CODE_LIVE_SHA"),
    codeRollbackTarget: optionalNone(pickValue(flags, envVars, "code-target", "CODE_ROLLBACK_TARGET")),
    gatewayDigest: optionalNone(pickValue(flags, envVars, "gateway-digest", "MODEL_GATEWAY_DIGEST")),
    expectedAccount: pickValue(flags, envVars, "expected-account", "ROVARA_EXPECTED_DEPLOY_ACCOUNT") ?? "",
    betaAccountId: pickValue(flags, envVars, "beta-account", "BETA_ACCOUNT_ID"),
    region: envVars.AWS_REGION ?? MODEL_GATEWAY_DEFAULT_REGION,
    dryRun: flags["dry-run"] === true || envVars.PIPELINE_DRY_RUN === "1",
    outDir: pickValue(flags, envVars, "out", "PIPELINE_OUT") ?? "out",
    manifestPath: pickValue(flags, envVars, "manifest", "PIPELINE_MANIFEST"),
    workDir: envVars.PIPELINE_WORK ?? `/tmp/rovara-gateway-${execId.slice(0, 8)}`,
    gatewayUrlOverride: pickValue(flags, envVars, "gateway-url", "MODEL_GATEWAY_URL"),
  };
}

async function dispatchStep(
  step: GatewayStepName,
  env: PipelineEnv,
  cfg: RunConfig,
  ports: Ports,
  repoDir: string,
  out: (line: string) => void,
): Promise<GatewayManifest> {
  if (step === "image") {
    if (cfg.codeRelease !== "skip" && !SHA40.test(cfg.codeSha)) throw new StageError("USAGE", "CODE_SHA must be a 40-character lowercase hex commit sha");
    const prev = readManifestFile(ports, cfg.manifestPath, env === "production" && cfg.mode !== "adopt" && cfg.codeRelease !== "skip");
    return imageStep({
      env, mode: cfg.mode, codeRelease: cfg.codeRelease, execId: cfg.execId, codeSha: cfg.codeSha,
      codeLiveSha: cfg.codeLiveSha, codeRollbackTarget: cfg.codeRollbackTarget, gatewayDigest: cfg.gatewayDigest,
      expectedAccount: cfg.expectedAccount, betaAccountId: cfg.betaAccountId, region: cfg.region,
      repoDir, workDir: cfg.workDir, dryRun: cfg.dryRun, previousManifest: prev, ports, log: out,
    });
  }
  const manifest = readManifestFile(ports, cfg.manifestPath, true)!;
  if (step === "deploy") {
    return deployStep({ env, region: cfg.region, repoDir, workDir: cfg.workDir, dryRun: cfg.dryRun, manifest, ports, log: out });
  }
  return checkStep({ env, repoDir, dryRun: cfg.dryRun, manifest, gatewayUrlOverride: cfg.gatewayUrlOverride, ports, log: out });
}

async function executeRunStep(
  step: GatewayStepName,
  env: PipelineEnv,
  flags: Record<string, string | true>,
  envVars: Record<string, string | undefined>,
  ports: Ports,
  repoDir: string,
  out: (line: string) => void,
): Promise<void> {
  const cfg = readRunConfig(flags, envVars);
  const updated = await dispatchStep(step, env, cfg, ports, repoDir, out);
  ports.fs.mkdirp(cfg.outDir);
  ports.fs.writeText(join(cfg.outDir, "manifest.json"), `${JSON.stringify(updated, null, 2)}\n`);
}

function resolveProfile(env: PipelineEnv, envVars: Record<string, string | undefined>): string | null {
  const configured = envVars.ROVARA_PIPELINE_PROFILE;
  if (configured !== undefined && configured !== "") return configured;
  return env === "beta" ? "agentx-beta" : null;
}

function handleCliError(error: unknown, where: string, out: (line: string) => void): number {
  if (error instanceof StageError) {
    if (error.exitName === "USAGE") out(error.message === "help" ? USAGE : `${error.message}\n${USAGE}`);
    else out(`GATEWAY-STAGE-FAILED ${where} ${error.exitName}: ${error.message}`);
    return error.message === "help" ? EXIT.OK : EXIT[error.exitName];
  }
  out(`GATEWAY-STAGE-FAILED ${where} FAILED: ${error instanceof Error ? error.message : String(error)}`);
  return EXIT.FAILED;
}

export async function main(argv: readonly string[], envVars: Record<string, string | undefined>, deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  let where = "model-gateway-release";
  try {
    const parsed = parseArgs(argv);
    where = `${parsed.env} ${parsed.step}`;
    const region = envVars.AWS_REGION ?? MODEL_GATEWAY_DEFAULT_REGION;
    const execId = pickValue(parsed.flags, envVars, "exec-id", "EXEC_ID") ?? "local000";
    const makePorts = deps.makePorts ?? createRealPorts;
    const ports = makePorts({ region, exec8: execId.slice(0, 8), profile: resolveProfile(parsed.env, envVars) });
    const repoDir = deps.repoDir ?? process.cwd();
    if (parsed.step === "last-good" || parsed.step === "rollback-plan") {
      return await runReadOnly(parsed.step, parsed.env, ports, repoDir, out);
    }
    await executeRunStep(parsed.step, parsed.env, parsed.flags, envVars, ports, repoDir, out);
    return EXIT.OK;
  } catch (error) {
    return handleCliError(error, where, out);
  }
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && dirname(process.argv[1]) === dirname(here) && process.argv[1].endsWith("cli.ts")) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
