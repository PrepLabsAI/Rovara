// The CDK context flags the census must turn on. A role in a stack behind a context flag is a role the boundaries must cover too (the requalify machine's GetRole was missed once because the
// census synthesized without the flags). `enumerateContextKeys()` reads the keys FROM THE CODE (every tryGetContext / getContext call in infra/lib), so a new flag cannot hide a role: the test
// that uses it fails until the new key is classified here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Flags that create resources (stacks, policies, roles): the census turns every one ON. */
export const GATE_FLAGS_ON: Readonly<Record<string, string>> = {
  "agentx:autoRequalify": "enabled",
  "agentx:autoRequalifySchedule": "enabled",
  "agentx:e2eQualificationTransport": "enabled",
  agentxInstaller: "enabled",
  agentxCiRunner: "enabled",
};
/** Keys that only carry a value (a name, a region, a setting, a number) or select another app mode: they gate no role of the environment's stacks, so the census leaves them at their default. */
export const VALUE_KEYS: readonly string[] = [
  "agentxEnv", "agentxRegion", "agentxDeploymentMode", "agentxIdentity", "agentxSynthesizer", "agentx:autoRequalifyHourUtc", "agentxDnsFirewall", "agentxEgressAllowDomains",
  "CoreModelGatewayHost", "agentxReleasePipeline", "agentxReleaseBranch",
  // The address stack (infra/lib/api-address.ts) is opted into by naming its domain; it declares no role (a topic policy and an alarm only), so the census has nothing to cover in it.
  "agentxApiAddress",
  // The model gateway's app mode (#1478): -c rovaraModelGateway=<env> makes only the gateway's two stacks, never an environment's, and the rest set
  // up those stacks. Every role there carries Cloud's boundary, which the RequireCloudBoundary aspect enforces at synth (infra/lib/model-gateway-boundary.ts).
  "rovaraModelGateway", "rovaraModelGatewayProductAi", "rovaraModelGatewayRovaraAi", "rovaraModelGatewayRovaraAiExempt", "rovaraModelGatewayRovaraAiDisabled",
  "rovaraModelGatewayOfferedPrices", "rovaraModelGatewayProviderSecretNames", "rovaraAiSourceKinds", "rovaraCodeSha",
];
/** Flags for stacks that exist only in the deployment that predates environments (no boundary applies there). */
export const LEGACY_ONLY_FLAGS: readonly string[] = ["agentxBetaAccess", "agentxBetaDomain"];

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === "dist" || name === "node_modules") return [];
  return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
});

/** Every context key the infra code reads: string literals passed to tryGetContext / getContext, and constants (`const NAME = "key"`) passed by name. */
export function enumerateContextKeys(infraDir = join(process.cwd(), "infra/lib")): string[] {
  const files = walk(infraDir).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const constants = new Map<string, string>();
  for (const { text } of files) for (const match of text.matchAll(/(?:^|\n)(?:export )?const ([A-Z][A-Z0-9_]*) = "([^"]+)"/gu)) constants.set(match[1]!, match[2]!);
  const keys = new Set<string>();
  for (const { path, text } of files) {
    for (const match of text.matchAll(/(?:tryGetContext|getContext)\(\s*([^),]+?)\s*[),]/gu)) {
      const argument = match[1]!;
      const literal = /^"([^"]+)"$/u.exec(argument);
      if (literal !== null) { keys.add(literal[1]!); continue; }
      const named = constants.get(argument);
      if (named === undefined) throw new Error(`${path}: the context key ${argument} is not a string literal or a known constant: classify it in tests/support/context-flags.ts and teach the enumerator`);
      keys.add(named);
    }
  }
  return [...keys].sort();
}
