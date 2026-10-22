#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeInstallChallengeSchema, WEB_API_RUNTIME_PROFILE_ID, canonicalJson, type RuntimeInstallChallenge, type WebApiProbeRun } from "@agentx/contracts";
import { containedRuntimeProfileForHost } from "./container-envelope.js";
import { createProcessDockerCli } from "./host/docker-application-host.js";
import { WEB_API_BUILD_IMAGE, createWebApiProbeRunner, type WebApiProbeModelChannelFactory } from "./host/web-api-probe-runner.js";
import { qualificationFailureOf } from "./install-qualification-failure.js";
import { qualifyInstalledP0Runtime,qualifyInstalledWebApiRuntime, type WebApiQualificationEnvironment } from "./install-qualification.js";

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`required option ${name} is missing`);
  return value;
}

type ProbeRunner = (probeId: string) => Promise<WebApiProbeRun>;
/** What the production web/API probe runner is built from, all of it read from the worker's own configuration. */
export type WebApiProbeRunnerConfig = Readonly<{ executorImage: string; buildImage: string; runRoot: string }>;

/**
 * Reads the runner's configuration, failing closed when any of it is missing. The executor image is the worker's `EXECUTOR_IMAGE` (the image its boot
 * script pulled), the build image is the pinned Node base, and the run root is a directory the worker shares with the Docker host at the same path.
 */
export function webApiProbeRunnerConfig(environment: NodeJS.ProcessEnv, platform: string = process.platform, arch: string = process.arch): WebApiProbeRunnerConfig {
  const executorImage = environment.EXECUTOR_IMAGE?.trim() ?? "";
  if (executorImage === "" || executorImage.length > 512 || /\s/.test(executorImage) || [...executorImage].some((character) => character.charCodeAt(0) < 0x20) || executorImage.startsWith("-")) {
    throw new Error("EXECUTOR_IMAGE is not set to an image reference on this worker, so the web/API runtime cannot be qualified here");
  }
  const scratch = containedRuntimeProfileForHost(platform, arch)?.candidateScratchRoot;
  if (scratch === undefined) throw new Error("this host has no shared runtime directory for web/API probe runs, so the web/API runtime cannot be qualified here");
  return { executorImage, buildImage: WEB_API_BUILD_IMAGE, runRoot: join(scratch, "web-api-probes") };
}

/**
 * The scripted model channel the agent probes run behind, from the installed worker: the proxy, the route checks and the receipts are the worker's, which this package cannot import.
 * The worker's build sits beside this one in the installed runtime. A worker that cannot supply it gives none, and the agent probes then do not run (the qualification is refused), so
 * the `agent` capability is never listed without them.
 */
export async function installedScriptedModelChannelFactory(workerBuild = new URL("../../worker/dist/e2e-qualification-model-channel.js", import.meta.url)): Promise<WebApiProbeModelChannelFactory | undefined> {
  // A fixed, path-free code goes to the qualification log, so a missing or broken module shows as such at the first real run and not only as `probe-run-failed`.
  let loaded: { createScriptedQualificationModelChannel?: unknown };
  try { loaded = await import(workerBuild.href) as typeof loaded; } catch { process.stderr.write("worker-scripted-channel-missing\n"); return undefined; }
  if (typeof loaded.createScriptedQualificationModelChannel === "function") return loaded.createScriptedQualificationModelChannel as WebApiProbeModelChannelFactory;
  process.stderr.write("worker-scripted-channel-invalid\n");
  return undefined;
}

export type QualificationCliDeps = Readonly<{
  /** Test seam: the scripted model channel the agent probes run behind, where the installed worker's would otherwise be loaded. */
  modelChannelFor?: WebApiProbeModelChannelFactory;
  environment?: NodeJS.ProcessEnv;
  /** Test seam: the platform and architecture the run root is looked up for. The default is this host. */
  host?: Readonly<{ platform: string; arch: string }>;
  /** Test seam: the run root and images, where the worker's own configuration would otherwise be read. */
  config?: Partial<WebApiProbeRunnerConfig>;
  /** Test seam: the host facts the qualifier reads (worker identity, installed manifest), for a CI host that is not the EC2 worker. */
  qualificationEnvironment?: Partial<WebApiQualificationEnvironment>;
  /** Test seam: builds the probe runner from its configuration, the challenge and the evidence root. The default is the production runner on the real Docker CLI. */
  createProbeRunner?: (input: WebApiProbeRunnerConfig & { challenge: RuntimeInstallChallenge; evidenceRoot: string }) => ProbeRunner;
}>;

/**
 * Runs the qualification. With `--failure-out <file>` a failure is also written there (mode 0600, created new): `{schemaVersion, stage, reasons, summary}` and nothing else.
 * The reasons are the qualifier's stable rejection codes (for example `probe-wrong-cause:api-egress-denial-v1`), the summary the enum and counter facts of the probes
 * they name, and any other error is only the stage it happened in. No error message is written; those stay in the log.
 */
export async function main(args: readonly string[], deps: QualificationCliDeps = {}): Promise<void> {
  let stage = "arguments-invalid";
  let failureOut: string | undefined;
  try {
    failureOut = args.includes("--failure-out") ? resolve(option(args, "--failure-out")) : undefined;
    await qualify(args, deps, (next) => { stage = next; });
  } catch (error) {
    if (failureOut !== undefined) await writeFile(failureOut, `${JSON.stringify(qualificationFailureOf(error, stage))}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(() => undefined);
    throw error;
  }
}

async function qualify(args: readonly string[], deps: QualificationCliDeps, at: (stage: string) => void): Promise<void> {
  const challengePath = resolve(option(args, "--challenge-file"));
  const evidenceRoot = resolve(option(args, "--evidence-root"));
  const outputPath = resolve(option(args, "--out"));
  at("challenge-invalid");
  const challenge = RuntimeInstallChallengeSchema.parse(JSON.parse(await readFile(challengePath, "utf8")));
  at("profile-mismatch");
  // Without --profile the standard P0 qualification runs, exactly as before (its own checks bind it to the challenge's profile).
  const profile = args.includes("--profile") ? option(args, "--profile") : undefined;
  if (profile !== undefined && profile !== "linux-arm64-docker-v1" && profile !== WEB_API_RUNTIME_PROFILE_ID) throw new Error(`unsupported runtime qualification profile ${profile}`);
  if (profile !== undefined && challenge.profileId !== profile) throw new Error(`the challenge is for profile ${challenge.profileId}, not ${profile}`);
  let proposal;
  if (profile === WEB_API_RUNTIME_PROFILE_ID) {
    at("runner-config-invalid");
    const config = { ...webApiProbeRunnerConfig(deps.environment ?? process.env, deps.host?.platform, deps.host?.arch), ...deps.config };
    const modelChannelFor = deps.modelChannelFor ?? await installedScriptedModelChannelFactory();
    const runProbe = (deps.createProbeRunner ?? ((input) => createWebApiProbeRunner({ ...input, docker: createProcessDockerCli(), ...(modelChannelFor === undefined ? {} : { modelChannelFor }) })))({ ...config, challenge, evidenceRoot });
    at("qualification-failed");
    proposal = await qualifyInstalledWebApiRuntime({ challenge, evidenceRoot, runProbe, ...(deps.qualificationEnvironment ? { environment: deps.qualificationEnvironment } : {}) });
  } else { at("qualification-failed"); proposal = await qualifyInstalledP0Runtime({ challenge, evidenceRoot }); }
  at("proposal-write-failed");
  await writeFile(outputPath, `${canonicalJson(proposal)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  process.stdout.write(`${canonicalJson({ status: "qualification-complete", profileId: challenge.profileId, proposalPath: outputPath, probeCount: proposal.probes.length, manifestSha256: proposal.manifest.sha256 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`runtime installation qualification failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
