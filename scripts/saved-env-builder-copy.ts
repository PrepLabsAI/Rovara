// SE-5: operator-run copy of a reviewed BuildKit index into agentx-<env>/*.
// Dry-run by default. No login or AWS calls here; the operator uses the existing
// guarded registry login and invokes --copy, then --verify. No mutable source tag.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ECR_REGISTRY_PATTERN, SAVED_ENV_BUILDER_DIGEST, SAVED_ENV_BUILDER_IMAGE, savedEnvRepositoryPrefix } from "../packages/contracts/src/index.js";
import { verifyMirror, type MirrorStep, type MirrorRegistry } from "./test-services-mirror.js";

export function builderCopyPlan(registry: string, env: string, source: string): MirrorStep {
  if (!ECR_REGISTRY_PATTERN.test(registry)) throw new Error("a private ECR registry is required");
  savedEnvRepositoryPrefix(env); // Use the repository contract's environment validation.
  if (source !== SAVED_ENV_BUILDER_IMAGE && source !== `docker.io/${SAVED_ENV_BUILDER_IMAGE}`) throw new Error("the reviewed rootless BuildKit index pinned by digest is required");
  const digest = SAVED_ENV_BUILDER_DIGEST;
  const repository = `${registry}/agentx-${env}/saved-env-builder`;
  return { requested: "saved environment builder", source: `docker.io/${SAVED_ENV_BUILDER_IMAGE}`, target: `${repository}:sha256-${digest.slice("sha256:".length)}`, pinned: `${repository}@${digest}`, digest };
}

export const verifyBuilderCopy = (step: MirrorStep, registry: MirrorRegistry): { ok: boolean; lines: string[] } => verifyMirror([step], registry);

export function main(argv: readonly string[]): number {
  const value = (flag: string): string => {
    const at = argv.indexOf(flag);
    const text = at < 0 ? undefined : argv[at + 1];
    if (text === undefined || text.startsWith("--")) throw new Error("registry, env and source are required");
    return text;
  };
  let step: MirrorStep;
  try {
    if (argv.includes("--copy") && argv.includes("--verify")) throw new Error("copy and verify are separate runs");
    step = builderCopyPlan(value("--registry"), value("--env"), value("--source"));
  } catch (error) { console.error(`saved-env-builder-copy: ${error instanceof Error ? error.message : "invalid arguments"}`); return 2; }
  const run = (...args: string[]): string => execFileSync("crane", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 600_000 });
  try {
    if (argv.includes("--copy")) run("copy", step.source, step.target);
    else if (argv.includes("--verify")) {
      const result = verifyBuilderCopy(step, { digest: reference => run("digest", reference), manifest: reference => run("manifest", reference) });
      for (const line of result.lines) console.log(line);
      if (!result.ok) return 1;
    } else console.log(`${step.source} -> ${step.target}`);
    console.log(`AGENTX_SAVED_ENV_BUILDER_IMAGE=${step.pinned}`);
    return 0;
  } catch { console.error("saved-env-builder-copy: the builder copy could not be completed"); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
