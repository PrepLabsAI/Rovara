/** Standalone execution-time guard for exported bundles. Keep the broker-first checks and the
 * health response contract aligned with gateway-price-preflight.ts; bundles run without the CLI. */
export function exportReadinessScript(input: { gatewayHost: string | undefined; agentModel: string | undefined; brokerStack: string; region: string; selectedBroker: boolean }): string {
  return `import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const config = ${JSON.stringify(input)};
const origin = config.gatewayHost ? "https://" + config.gatewayHost : "<unconfigured gateway>";
function refuse(message) {
  console.error(origin + ": " + message);
  process.exit(1);
}
function completedBroker() {
  try {
    const text = execFileSync("aws", ["cloudformation", "describe-stacks", "--stack-name", config.brokerStack, "--region", config.region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const outputs = JSON.parse(text).Stacks?.[0]?.Outputs;
    if (!Array.isArray(outputs) || !outputs.some(output => output.OutputKey === "ModelRunPriceVersion" && output.OutputValue === "1")) throw new Error();
  } catch {
    refuse("the price-serving broker must be installed before worker activation; install gateway, then broker, then worker");
  }
}
if (config.selectedBroker) {
  try {
    const text = await readFile(new URL("templates/control-plane.template.json", import.meta.url), "utf8");
    if (JSON.parse(text).Outputs?.ModelRunPriceVersion?.Value !== "1") throw new Error();
  } catch {
    refuse("the selected control-plane template must contain a price-serving broker (ModelRunPriceVersion=1); build a current release before installing or upgrading");
  }
} else {
  completedBroker();
}
// Runtime activation also checks the completed stack, after its selected artifact has deployed.
if (config.selectedBroker && process.argv.includes("--runtime")) completedBroker();
if (!config.gatewayHost || !config.agentModel) {
  refuse("coreEngine.modelGatewayUrl and coreEngine.agentModel must both be configured before worker activation; supply coreEngine answers to repair this install");
}
try {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error();
  const response = await fetch(origin + "/healthz", { redirect: "error", signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
  const body = await response.json();
  if (response.status !== 200 || body?.runPrice?.version !== 1 || body.runPrice.admissionVersion !== 1 || !Number.isSafeInteger(body.runPrice.snapshotVersion) || body.runPrice.snapshotVersion <= 0) throw new Error();
} catch {
  refuse("the gateway must serve run prices from a signed, versioned snapshot before this engine can be installed or upgraded; install or repair the gateway first");
}
`;
}
