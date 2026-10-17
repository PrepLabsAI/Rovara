#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeInstallChallengeSchema, canonicalJson } from "@agentx/contracts";
import { qualifyInstalledP0Runtime } from "./install-qualification.js";

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`required option ${name} is missing`);
  return value;
}

async function main(args: readonly string[]): Promise<void> {
  const challengePath = resolve(option(args, "--challenge-file"));
  const evidenceRoot = resolve(option(args, "--evidence-root"));
  const outputPath = resolve(option(args, "--out"));
  const challenge = RuntimeInstallChallengeSchema.parse(JSON.parse(await readFile(challengePath, "utf8")));
  const proposal = await qualifyInstalledP0Runtime({ challenge, evidenceRoot });
  await writeFile(outputPath, `${canonicalJson(proposal)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  process.stdout.write(`${canonicalJson({ status: "qualification-complete", profileId: challenge.profileId, proposalPath: outputPath, probeCount: proposal.probes.length, manifestSha256: proposal.manifest.sha256 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`runtime installation qualification failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
