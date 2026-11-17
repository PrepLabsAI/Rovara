// DEC 254zm: copy the five test-service starter images into this install's own ECR repositories BY DIGEST, and check the copies. The controller runs it; it makes no AWS call itself.
//
//   1. Log crane in to the registry with the staging guard (the password goes through a pipe, never a file or the log):
//        ~/.local/share/rovara-tools/staging-aws.sh ecr get-login-password | crane auth login <account>.dkr.ecr.<region>.amazonaws.com -u AWS --password-stdin
//   2. See what will be copied (no network):   npx tsx scripts/test-services-mirror.ts --registry <registry> --env <environment>
//   3. Copy:                                     npx tsx scripts/test-services-mirror.ts --registry <registry> --env <environment> --copy
//      Each copy is `crane copy docker.io/library/<image>@sha256:<pinned> <registry>/<repository>:<major>-<first 12 of the digest>`: crane copies the multi-platform index and every platform image
//      byte for byte, so the copy's index digest IS the pinned digest. The tag is a label (immutable, unique per digest); the digest is the identity.
//   4. Check (the gate before `agentx config set testServices.images mirrored`):
//        npx tsx scripts/test-services-mirror.ts --registry <registry> --env <environment> --verify
//      For every starter: the copy answers by the pinned digest, its tag points at that same digest, and its index lists linux/arm64 (Code's workers) and linux/amd64, each of which answers by its own digest in
//      the copy. Exit 0 only when all five pass. Run --copy once per environment (the tags are immutable); if a copy stopped midway, --verify names what is missing.
//   5. Log out: crane auth logout <registry>
//
// The repositories, names, tags and digests come from @agentx/contracts (test-service-mirror.ts over owner-starter-images.ts), the same functions the infrastructure and the worker's boot stage use.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { testServiceMirrorRepositories, type TestServiceMirrorRepository, ECR_REGISTRY_PATTERN } from "../packages/contracts/src/index.js";

export interface MirrorStep {
  requested: string;
  source: string;
  /** Where the copy is pushed: by its label tag. */
  target: string;
  /** How the copy is pulled and checked: by the pinned digest. */
  pinned: string;
  digest: string;
}

/** What `--copy` does, one step per starter image. Throws on a registry or environment that is not one. */
export function mirrorPlan(registry: string, env: string): MirrorStep[] {
  if (!ECR_REGISTRY_PATTERN.test(registry)) throw new Error("--registry must be <account>.dkr.ecr.<region>.amazonaws.com");
  return testServiceMirrorRepositories(env).map((repository: TestServiceMirrorRepository) => ({
    requested: repository.starter.requested,
    source: repository.starter.reference,
    target: `${registry}/${repository.repositoryName}:${repository.tag}`,
    pinned: `${registry}/${repository.repositoryName}@sha256:${repository.digest}`,
    digest: `sha256:${repository.digest}`,
  }));
}

/** The registry calls `--verify` needs, so a test can answer them. */
export interface MirrorRegistry {
  /** `crane digest <reference>`: the digest the registry answers for it, or throws. */
  digest(reference: string): string;
  /** `crane manifest <reference>`: the manifest text, or throws. */
  manifest(reference: string): string;
}

/** One line per starter, and whether every copy passed. */
export function verifyMirror(steps: readonly MirrorStep[], registry: MirrorRegistry): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  for (const step of steps) {
    const problems: string[] = [];
    try {
      if (registry.digest(step.pinned).trim() !== step.digest) problems.push("the copy does not answer by the pinned digest");
    } catch { problems.push("no copy by the pinned digest"); }
    try {
      if (registry.digest(step.target).trim() !== step.digest) problems.push("the tag points at another digest");
    } catch { problems.push("no copy by its tag"); }
    try {
      const index = JSON.parse(registry.manifest(step.pinned)) as { manifests?: Array<{ digest?: string; platform?: { os?: string; architecture?: string } }> };
      const repository = step.pinned.slice(0, step.pinned.indexOf("@"));
      for (const platform of ["linux/arm64", "linux/amd64"]) {
        const child = (index.manifests ?? []).find((entry) => `${entry.platform?.os ?? ""}/${entry.platform?.architecture ?? ""}` === platform);
        if (child === undefined || typeof child.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(child.digest)) { problems.push(`the copy's index does not list ${platform}`); continue; }
        // The platform image itself must be in the copy (a partial copy would pass the index check and fail at the worker's pull).
        try {
          if (registry.digest(`${repository}@${child.digest}`).trim() !== child.digest) problems.push(`the ${platform} image is not in the copy`);
        } catch { problems.push(`the ${platform} image is not in the copy`); }
      }
    } catch { problems.push("the copy's index could not be read"); }
    if (problems.length > 0) ok = false;
    lines.push(`${problems.length === 0 ? "OK  " : "FAIL"} ${step.requested} ${step.pinned}${problems.length === 0 ? "" : `: ${problems.join("; ")}`}`);
  }
  return { ok, lines };
}

function argsOf(argv: readonly string[]): { registry: string; env: string; mode: "plan" | "copy" | "verify" } {
  const value = (name: string): string => {
    const at = argv.indexOf(name);
    const found = at < 0 ? undefined : argv[at + 1];
    if (found === undefined || found.startsWith("--")) throw new Error(`${name} is required`);
    return found;
  };
  const copy = argv.includes("--copy");
  const verify = argv.includes("--verify");
  if (copy && verify) throw new Error("--copy and --verify are separate runs");
  return { registry: value("--registry"), env: value("--env"), mode: copy ? "copy" : verify ? "verify" : "plan" };
}

export function main(argv: readonly string[]): number {
  let args;
  let steps: MirrorStep[];
  try {
    args = argsOf(argv);
    steps = mirrorPlan(args.registry, args.env);
  } catch (error) {
    console.error(`test-services-mirror: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 2;
  }
  const crane = process.env["CRANE"] ?? "crane";
  const run = (...craneArgs: string[]): string => execFileSync(crane, craneArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 600_000 });
  if (args.mode === "plan") {
    for (const step of steps) console.log(`${step.requested}: ${step.source} -> ${step.target} (pulled as ${step.pinned})`);
    return 0;
  }
  if (args.mode === "copy") {
    for (const step of steps) {
      console.log(`copying ${step.requested} -> ${step.target}`);
      run("copy", step.source, step.target);
    }
    console.log("copied; now run --verify");
    return 0;
  }
  const result = verifyMirror(steps, { digest: (reference) => run("digest", reference), manifest: (reference) => run("manifest", reference) });
  for (const line of result.lines) console.log(line);
  console.log(result.ok ? "VERIFIED: all five copies answer by their pinned digests" : "NOT VERIFIED: do not set testServices.images to mirrored");
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
