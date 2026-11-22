import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
/** Execute the production boot environment writer, replacing root-only file installation. No AWS/IMDS/Docker is contacted. */
export function hostedBootEnvironment(root: string, workspaceId: string, egress: "bridge" | "gateway"): NodeJS.ProcessEnv {
  const script = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
  const start = script.indexOf("\nwrite_worker_environment() {");
  let writer = script.slice(start + 1, script.indexOf("\n}\n", start) + 3)
    .replace('install -d -m 0700 "$(dirname "$WORKER_ENV_FILE")"', ":")
    .replace('install -m 0600 /dev/null "$WORKER_ENV_FILE"', ': >"$WORKER_ENV_FILE"');
  if (egress === "gateway") {
    const stage = readFileSync(new URL("../../packages/worker/ec2/sandbox-egress.sh", import.meta.url), "utf8");
    const append = stage.split("\n").find(line => line.includes("printf 'AGENTX_SANDBOX_EGRESS=gateway"));
    if (append === undefined) throw new Error("gateway environment writer missing");
    writer += `\nwrite_worker_environment us-east-1\n${append}`;
  } else writer += "\nwrite_worker_environment us-east-1";
  const file = join(root, "worker.env");
  const ran = spawnSync("bash", ["-c", writer], { encoding: "utf8", env: { PATH: process.env.PATH,
    WORKER_ENV_FILE: file, MOUNT_PATH: root, AGENTX_CONTROL_PLANE_URL: "https://broker.example", AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: "boot-default",
    PI_CACHE_RETENTION: "short", AGENTX_INVOKE_PUBLIC_KEY: "fixture", AGENTX_WORKSPACE_ID: workspaceId, AGENTX_SESSION_GENERATION: "1",
    AGENTX_WORKER_IMAGE: `registry.example/worker@sha256:${"a".repeat(64)}`, SE_INNER_NET: "rovara-snet", SE_INNER_IP: "172.28.250.2", SE_OUTER_IP: "172.28.251.2", SE_PROXY_PORT: "8080" } });
  if (ran.status !== 0) throw new Error(`boot environment failed: ${ran.stderr}`);
  return Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}
