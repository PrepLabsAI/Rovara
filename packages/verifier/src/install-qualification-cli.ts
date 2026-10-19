#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeInstallChallengeSchema, WEB_API_RUNTIME_PROFILE_ID, canonicalJson, type WebApiProbeObservation } from "@agentx/contracts";
import { qualifyInstalledP0Runtime, qualifyInstalledWebApiRuntime } from "./install-qualification.js";

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`required option ${name} is missing`);
  return value;
}

type ProbeRunner = (probeId: string) => Promise<WebApiProbeObservation>;
/** Supplies the installed runner that drives each web/API probe through the real Docker host and collector. None is installed yet, so the web/API profile fails closed. */
export type InstalledProbeRunnerLoader = () => Promise<ProbeRunner | undefined>;

export async function main(args: readonly string[], loadWebApiProbeRunner: InstalledProbeRunnerLoader = async () => undefined): Promise<void> {
  const challengePath = resolve(option(args, "--challenge-file"));
  const evidenceRoot = resolve(option(args, "--evidence-root"));
  const outputPath = resolve(option(args, "--out"));
  const challenge = RuntimeInstallChallengeSchema.parse(JSON.parse(await readFile(challengePath, "utf8")));
  // Without --profile the standard P0 qualification runs, exactly as before (its own checks bind it to the challenge's profile).
  const profile = args.includes("--profile") ? option(args, "--profile") : undefined;
  if (profile !== undefined && profile !== "linux-arm64-docker-v1" && profile !== WEB_API_RUNTIME_PROFILE_ID) throw new Error(`unsupported runtime qualification profile ${profile}`);
  if (profile !== undefined && challenge.profileId !== profile) throw new Error(`the challenge is for profile ${challenge.profileId}, not ${profile}`);
  let proposal;
  if (profile === WEB_API_RUNTIME_PROFILE_ID) {
    const runProbe = await loadWebApiProbeRunner();
    if (!runProbe) throw new Error("the web/API probe runner is not installed on this host, so the web/API runtime cannot be qualified here");
    proposal = await qualifyInstalledWebApiRuntime({ challenge, evidenceRoot, runProbe });
  } else proposal = await qualifyInstalledP0Runtime({ challenge, evidenceRoot });
  await writeFile(outputPath, `${canonicalJson(proposal)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  process.stdout.write(`${canonicalJson({ status: "qualification-complete", profileId: challenge.profileId, proposalPath: outputPath, probeCount: proposal.probes.length, manifestSha256: proposal.manifest.sha256 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`runtime installation qualification failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
