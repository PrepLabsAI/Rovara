// The "byte-identical templates" proof for install-layer refactors (F1 lane L1a-0, and any later lane that must not change a template).
//
// Why a hash and not the snapshots: the snapshot tests strip exactly the parts a settings refactor rewrites (the core engine's parameters, the broker names parameter, the packed
// pieces) and only three legacy templates and one named template have full pins. This script synthesises the FULL matrix below and prints one sha256 per template, so the same
// command at the base sha and at a lane sha can be diffed line by line: every line must be equal.
//
// The matrix (each context set is one synth; every stack of the assembly is hashed):
//   release:*          the release package as scripts/release/build.ts builds it: the placeholder environment, agentxSynthesizer legacy, every SUPPORTED_REGIONS, once WITH
//                      CoreModelGatewayHost (the context that changes the CoreAgentModel parameter, core-engine.ts) and once WITHOUT (the no-gateway restore is a deploy-time
//                      step in the CLI, not a synth output, so the matrix covers both synth outputs);
//   production:*       the legacy (un-named) install as release-production.ts synthesises it: agentxRegion, and the foundation's DNS firewall contexts it reads back
//                      (agentxDnsFirewall off|watch|block, agentxEgressAllowDomains);
//   optional:*         the optional stacks (installer, CI runner, beta access, beta domain, eval), the oidc identity mode, the agentx:autoRequalify* and
//                      agentx:e2eQualificationTransport contexts, in the legacy and the named layouts;
//   named:*            a named environment (default synthesiser and the legacy one), with and without CoreModelGatewayHost;
//   pipeline:*         the environment release pipeline stack (agentxReleasePipeline), also with a named environment beside it;
//   iam:*              the four context sets scripts/validate-iam-policies.ts already scans.
// Only the 64-hex asset hashes and the asset parameters' 8-hex path suffix are normalised (normalizeTemplateText; tests/support/template-snapshot.ts masks the first). Lambda bundling is switched off (the same switch the template tests use): a bundle
// changes nothing but those hashes.
//
// Usage, from the repository root (after `npm run typecheck`, which builds the packages the infrastructure imports):
//   tsx scripts/template-hash-matrix.ts [--out <file>]      prints `<sha256>  <context set> / <stack>` lines, sorted by name, then one line with the sha256 of all of them
//   diff <(base run) <(lane run)>                           must print nothing
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ENVIRONMENT_PLACEHOLDER } from "@agentx/contracts";
import { buildAgentXApp } from "../infra/lib/app.js";
import { SUPPORTED_REGIONS } from "../infra/lib/production-foundation.js";

/** Same switch as tests/support/skip-bundling.ts, set before the first App is built. */
process.env.CDK_CONTEXT_JSON = JSON.stringify({ "aws:cdk:bundling-stacks": [] });

type Context = Record<string, unknown>;
export interface ContextSet { name: string; context: Context }

const RELEASE_ENV = ENVIRONMENT_PLACEHOLDER;
const GATEWAY = "gateway.example";
const OPTIONAL_LEGACY: Context = { agentxBetaAccess: "enabled", agentxBetaDomain: "enabled", agentxInstaller: "enabled", agentxCiRunner: "enabled" };
const REQUALIFY: Context = { "agentx:autoRequalify": "enabled", "agentx:autoRequalifySchedule": "enabled", "agentx:autoRequalifyHourUtc": "5", "agentx:e2eQualificationTransport": "enabled" };

export function contextSets(): ContextSet[] {
  const sets: ContextSet[] = [];
  for (const region of SUPPORTED_REGIONS) {
    sets.push({ name: `release:${region}:gateway`, context: { agentxEnv: RELEASE_ENV, agentxSynthesizer: "legacy", agentxRegion: region, CoreModelGatewayHost: GATEWAY } });
    sets.push({ name: `release:${region}:no-gateway`, context: { agentxEnv: RELEASE_ENV, agentxSynthesizer: "legacy", agentxRegion: region } });
  }
  sets.push({ name: "production:default", context: {} });
  for (const region of ["us-east-1", "us-west-2"]) {
    sets.push({ name: `production:${region}`, context: { agentxRegion: region } });
    for (const mode of ["off", "watch", "block"]) {
      sets.push({ name: `production:${region}:firewall-${mode}`, context: { agentxRegion: region, agentxDnsFirewall: mode } });
      sets.push({ name: `production:${region}:firewall-${mode}:domains`, context: { agentxRegion: region, agentxDnsFirewall: mode, agentxEgressAllowDomains: "example.com,example.org" } });
    }
  }
  sets.push({ name: "optional:legacy:all", context: { agentxRegion: "us-west-2", ...OPTIONAL_LEGACY, ...REQUALIFY } });
  sets.push({ name: "optional:legacy:requalify", context: { agentxRegion: "us-west-2", ...REQUALIFY } });
  sets.push({ name: "optional:legacy:gateway", context: { agentxRegion: "us-west-2", CoreModelGatewayHost: GATEWAY } });
  for (const key of ["agentxInstaller", "agentxCiRunner", "agentxBetaAccess", "agentxBetaDomain"]) sets.push({ name: `optional:legacy:${key}`, context: { agentxRegion: "us-west-2", [key]: "enabled" } });
  sets.push({ name: "named:staging", context: { agentxEnv: "staging", agentxRegion: "us-west-2" } });
  sets.push({ name: "named:staging:gateway", context: { agentxEnv: "staging", agentxRegion: "us-west-2", CoreModelGatewayHost: GATEWAY } });
  sets.push({ name: "named:staging:legacy-synth", context: { agentxEnv: "staging", agentxSynthesizer: "legacy", agentxRegion: "us-west-2" } });
  sets.push({ name: "named:staging:oidc", context: { agentxEnv: "staging", agentxRegion: "us-west-2", agentxIdentity: "oidc" } });
  sets.push({ name: "named:staging:cognito", context: { agentxEnv: "staging", agentxRegion: "us-west-2", agentxIdentity: "cognito" } });
  sets.push({ name: "named:staging:requalify", context: { agentxEnv: "staging", agentxRegion: "us-west-2", ...REQUALIFY } });
  sets.push({ name: "named:staging:optional", context: { agentxEnv: "staging", agentxRegion: "us-west-2", agentxInstaller: "enabled", agentxCiRunner: "enabled", ...REQUALIFY } });
  sets.push({ name: "named:staging:oidc:gateway:requalify", context: { agentxEnv: "staging", agentxRegion: "us-west-2", agentxIdentity: "oidc", CoreModelGatewayHost: GATEWAY, ...REQUALIFY } });
  sets.push({ name: "pipeline:staging", context: { agentxReleasePipeline: "staging", agentxRegion: "us-west-2" } });
  sets.push({ name: "pipeline:staging:named", context: { agentxReleasePipeline: "staging", agentxEnv: "staging", agentxRegion: "us-west-2" } });
  // scripts/validate-iam-policies.ts SCAN_CONTEXTS, copied: that file runs an AWS gate when imported.
  sets.push({ name: "iam:legacy", context: { agentxRegion: "us-west-2" } });
  sets.push({ name: "iam:legacy-optional", context: { agentxRegion: "us-west-2", agentxBetaAccess: "enabled", agentxBetaDomain: "enabled", agentxInstaller: "enabled", agentxCiRunner: "enabled", "agentx:autoRequalify": "enabled", "agentx:autoRequalifySchedule": "enabled", "agentx:e2eQualificationTransport": "enabled" } });
  sets.push({ name: "iam:named", context: { agentxEnv: "staging", agentxRegion: "us-west-2", "agentx:autoRequalify": "enabled", "agentx:autoRequalifySchedule": "enabled", "agentx:e2eQualificationTransport": "enabled", agentxInstaller: "enabled", agentxCiRunner: "enabled" } });
  sets.push({ name: "iam:release-pipeline", context: { agentxReleasePipeline: "staging", agentxRegion: "us-west-2" } });
  return sets;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The template text with the path-dependent parts masked: the 64-hex asset hashes, and the 8-hex suffix CDK adds to an asset parameter's logical id (it follows the asset hash, which with bundling
 * skipped depends on the absolute folder the app was synthesised from; it is not the construct path), so a base from `git archive` or another worktree compares with a lane in this one.
 */
export function normalizeTemplateText(text: string): string {
  return text.replace(/[a-f0-9]{64}/gu, "<asset-hash>").replace(/(AssetParameters<asset-hash>(?:S3Bucket|S3VersionKey|ArtifactHash))[0-9A-F]{8}/gu, "$1<path-hash>");
}

/** One line per template: the sha256 of the normalised template JSON. */
export function hashContextSet(set: ContextSet): string[] {
  const assembly = buildAgentXApp({ ...set.context }).synth();
  return assembly.stacks.map((stack) => `${sha256(normalizeTemplateText(JSON.stringify(stack.template)))}  ${set.name} / ${stack.stackName}`).sort();
}

function main(): void {
  const outIndex = process.argv.indexOf("--out");
  const lines: string[] = [];
  for (const set of contextSets()) {
    const hashes = hashContextSet(set);
    lines.push(...hashes);
    process.stderr.write(`${set.name}: ${hashes.length} templates\n`);
  }
  lines.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : a.slice(66) > b.slice(66) ? 1 : 0));
  const text = `${lines.join("\n")}\n${sha256(lines.join("\n"))}  ALL ${lines.length} templates\n`;
  if (outIndex >= 0) writeFileSync(process.argv[outIndex + 1]!, text);
  else process.stdout.write(text);
}

if (process.argv[1]?.endsWith("template-hash-matrix.ts")) main();
