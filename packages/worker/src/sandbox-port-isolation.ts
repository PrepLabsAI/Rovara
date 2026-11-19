// Internal worker gate for the trusted sleeping task/setup containers only.
import { agentXError } from "@agentx/contracts";
import type { DockerCli } from "./swebench/containers.js";

const PORT_INDEX_SOURCE = 'const fs=require("fs");const root="/sys/class/net/";const names=fs.readdirSync(root).filter(n=>fs.readFileSync(root+n+"/address","utf8").trim()===process.argv[1]);if(names.length!==1)process.exit(1);process.stdout.write(fs.readFileSync(root+names[0]+"/iflink","utf8"));';
const ISOLATE_SOURCE = '. /opt/agentx/packages/worker/ec2/sandbox-egress.sh; se_port_isolation "$1" on';

/** No repository input, mounts, socket, environment or entrypoint reaches the host-network helper. */
export function sandboxPortIsolationArgs(image: string, index: string): string[] {
  if (!/^[1-9][0-9]{0,9}$/u.test(index)) throw agentXError("RUNTIME_UNAVAILABLE", "the sandbox bridge port could not be identified");
  return ["run", "--rm", "--pull=never", "--network", "host", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "32", "--memory", "64m", "--entrypoint", "/bin/bash", image, "-c", ISOLATE_SOURCE, "--", index];
}

export async function isolateSandboxPort(docker: DockerCli, container: string, image: string): Promise<void> {
  const options = { timeoutMs: 15_000 };
  const mac = await docker.run(["inspect", "--format", '{{(index .NetworkSettings.Networks "rovara-snet").MacAddress}}', container], options);
  if (mac.exitCode !== 0 || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/u.test(mac.stdout.trim())) throw new Error("missing sandbox endpoint");
  const port = await docker.run(["exec", container, "/usr/local/bin/node", "-e", PORT_INDEX_SOURCE, mac.stdout.trim()], options);
  if (port.exitCode !== 0) throw new Error("missing sandbox port");
  const isolated = await docker.run(sandboxPortIsolationArgs(image, port.stdout.trim()), options);
  if (isolated.exitCode !== 0) throw new Error("sandbox bridge port isolation could not be set and verified");
}
