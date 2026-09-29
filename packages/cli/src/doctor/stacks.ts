// FR-050: that stacks exist and are healthy, that they run the release the settings name, the engine
// they were deployed with, and their last drift result.
import { environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import { installOrder, type DeployPart } from "../deploy/parameters.js";
import { check, type DoctorCheck, type DoctorContext, type DoctorStack } from "./checks.js";

const HEALTHY = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);
const IMAGE_PARAMETERS: Partial<Record<DeployPart, { parameter: string; image: "worker" | "slack" }>> = {
  runtime: { parameter: "WorkerImageUri", image: "worker" },
  slack: { parameter: "OrchestratorImageUri", image: "slack" },
};

/** The parameters of `part` that differ from the release: code packages by asset hash (a failure),
 * images by digest (a warning: the testing-only image flags set other digests on purpose). */
export function releaseMismatch(part: DeployPart, parameters: Record<string, string>, manifest: ReleaseManifest): { code: string[]; images: string[] } {
  const code = manifest.packages.filter((pkg) => pkg.parts.includes(part) && parameters[pkg.hashParameter] !== pkg.assetId).map((pkg) => pkg.hashParameter);
  const images: string[] = [];
  const image = IMAGE_PARAMETERS[part];
  const digest = image === undefined ? undefined : manifest.images[image.image]?.split("@")[1];
  if (image !== undefined && digest !== undefined && !(parameters[image.parameter] ?? "").endsWith(`@${digest}`)) images.push(image.parameter);
  return { code, images };
}

/** Only a cdk-deployed stack (DefaultStackSynthesizer) declares BootstrapVersion; the templates
 * engine's stacks (LegacyStackSynthesizer) never do. */
const deployedWithCdk = (stack: DoctorStack) => Object.hasOwn(stack.parameters, "BootstrapVersion");

function stackHealth(env: string, region: string, name: string, stack: DoctorStack | undefined): DoctorCheck {
  if (stack === undefined) return check("stacks", name, "fail", "does not exist", `agentx --env ${env} upgrade deploys it again`);
  const status = stack.status;
  const events = `aws cloudformation describe-stack-events --stack-name ${name} --region ${region}`;
  if (HEALTHY.has(status)) return check("stacks", name, "ok", status);
  if (status === "UPDATE_ROLLBACK_COMPLETE") return check("stacks", name, "warn", `${status}: its last update was rolled back, so it runs the previous version`, `read its events (${events}), fix the cause, then run agentx --env ${env} upgrade`);
  if (status.endsWith("_IN_PROGRESS")) return check("stacks", name, "warn", `${status}: CloudFormation is still working on it`, "run agentx doctor again when it finishes");
  if (status === "ROLLBACK_COMPLETE") {
    return check("stacks", name, "fail", `${status}: its first create failed`, `delete it (aws cloudformation delete-stack --stack-name ${name} --region ${region}) and run agentx init --env ${env} --region ${region} again, or remove the whole environment with agentx --env ${env} destroy --region ${region}`);
  }
  return check("stacks", name, "fail", status, `see its events (${events})`);
}

export async function stackChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, services } = context;
  const described = new Map<DeployPart, { name: string; stack: DoctorStack | undefined }>();
  const checks: DoctorCheck[] = [];
  for (const part of installOrder(settings.identity.mode)) {
    const name = settings.stacks[part] ?? environmentStackName(env, part);
    const stack = await services.stacks.describe(name);
    described.set(part, { name, stack });
    checks.push(stackHealth(env, settings.region, name, stack));
  }

  const wrongEngine = [...described.values()].flatMap(({ name, stack }) => {
    if (stack === undefined) return [];
    const used = deployedWithCdk(stack) ? "cdk" : "templates";
    return used === settings.engine ? [] : [`${name} (${used})`];
  });
  checks.push(wrongEngine.length === 0
    ? check("stacks", "engine", "ok", `every stack was deployed with the ${settings.engine} engine`)
    : check("stacks", "engine", "fail", `the settings say ${settings.engine}, but ${wrongEngine.join(", ")} ${wrongEngine.length === 1 ? "was" : "were"} deployed with the other engine; switching engines is not supported`, `redeploy with the ${settings.engine} engine: agentx --env ${env} upgrade uses the engine in the settings`));

  const existing = [...described.values()].filter((entry): entry is { name: string; stack: DoctorStack } => entry.stack !== undefined);
  const drifted = existing.filter(({ stack }) => stack.drift === "DRIFTED").map(({ name }) => name);
  const inSync = existing.filter(({ stack }) => stack.drift === "IN_SYNC").map(({ name }) => name);
  const unchecked = existing.filter(({ stack }) => stack.drift !== "IN_SYNC" && stack.drift !== "DRIFTED").map(({ name }) => name);
  const detect = `detecting it needs admin credentials (${unchecked.map((name) => `aws cloudformation detect-stack-drift --stack-name ${name} --region ${settings.region}`).join("; ")})`;
  // Only stacks that were never checked are named as such: a partly checked environment never reads as fully checked.
  const notChecked = unchecked.length === 0 ? "" : inSync.length === 0 && drifted.length === 0 ? `drift has not been checked; ${detect}` : `drift has not been checked for ${unchecked.join(", ")}; ${detect}`;
  if (drifted.length > 0) {
    checks.push(check("stacks", "drift", "warn", `${drifted.join(", ")} changed outside CloudFormation (at the last drift check)${notChecked === "" ? "" : `; ${notChecked}`}`, `see what changed, with admin credentials: ${drifted.map((name) => `aws cloudformation describe-stack-resource-drifts --stack-name ${name} --region ${settings.region}`).join("; ")}; then undo it by hand or run agentx --env ${env} upgrade`));
  } else if (inSync.length === 0) {
    checks.push(check("stacks", "drift", "ok", notChecked === "" ? "no stack to check" : notChecked));
  } else {
    checks.push(check("stacks", "drift", "ok", unchecked.length === 0 ? "no drift at the last drift check" : `no drift at the last drift check for ${inSync.join(", ")}; ${notChecked}`));
  }

  const title = `release ${settings.version}`;
  const manifest = await services.releaseManifest(settings.version);
  if (manifest === undefined) {
    checks.push(check("stacks", title, "warn", `could not read release ${settings.version}'s release.json, so the stacks' versions were not compared`, "check this computer's network access to github.com, then run agentx doctor again"));
    return checks;
  }
  const code: string[] = [];
  const images: string[] = [];
  let cdkStacks = 0;
  // On cdk the image digest is the only sign of a stale release, so a mismatch there is not blamed on the testing flags alone.
  let cdkMismatch = false;
  for (const [part, { name, stack }] of described) {
    if (stack === undefined) continue;
    const found = releaseMismatch(part, stack.parameters, manifest);
    // Ruling F4: a cdk stack's code lives in the bootstrap bucket and it declares no asset
    // parameters, so only its image digests are compared.
    if (deployedWithCdk(stack)) cdkStacks += 1;
    else code.push(...found.code.map((parameter) => `${name} ${parameter}`));
    if (found.images.length > 0 && deployedWithCdk(stack)) cdkMismatch = true;
    images.push(...found.images.map((parameter) => `${name} ${parameter}`));
  }
  if (code.length > 0) checks.push(check("stacks", title, "fail", `${code.join(", ")} ${code.length === 1 ? "does" : "do"} not match release ${settings.version}'s code packages`, `agentx --env ${env} upgrade --to ${settings.version}`));
  else if (images.length > 0) checks.push(check("stacks", title, "warn", `${images.join(", ")} ${images.length === 1 ? "is not" : "are not"} release ${settings.version}'s image (the testing-only image flags set this${cdkMismatch ? ", or the stack runs another release" : ""})`, `agentx --env ${env} upgrade --to ${settings.version}, without --worker-image or --slack-image`));
  else checks.push(check("stacks", title, "ok", cdkStacks === 0 ? `every stack runs release ${settings.version}'s code and images` : `every stack runs release ${settings.version}'s images; cdk: code packages are not compared (they live in the bootstrap bucket)`));
  return checks;
}
