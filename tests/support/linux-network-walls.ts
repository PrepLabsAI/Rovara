import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { promisify } from "node:util";
import { APP_NODE_IMAGE } from "./linux-runtime.js";

const execFileAsync = promisify(execFile);
type Result = { code: number; stdout: string; stderr: string };
const run = (file: string, args: string[]): Promise<Result> => execFileAsync(file, args).then(
  ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
  (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
export const docker = (...args: string[]) => run("docker", args);
export const sudo = (...args: string[]) => run("sudo", ["-n", ...args]);

/**
 * The rules the CI job installs from boot.sh before any test runs; a test that finds them missing says so instead of passing vacuously. Each rule is asked
 * for with `iptables -C` (exit 0 = present), never matched against `iptables -S` text, whose option order is the backend's own.
 */
export async function assertFirewallInstalled(): Promise<void> {
  const rules: string[][] = [["INPUT", "-i", "rvb+", "-j", "DROP"], ["INPUT", "-i", "rvi+", "-j", "DROP"], ["DOCKER-USER", "-i", "rvi+", "!", "-o", "rvi+", "-j", "DROP"],
    ...["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"].map((range) => ["DOCKER-USER", "-i", "rvb+", "-d", range, "-j", "DROP"]),
    ["DOCKER-USER", "-d", "169.254.169.254/32", "-j", "DROP"]];
  const missing: string[] = [];
  for (const rule of rules) if ((await sudo("iptables", "-C", ...rule)).code !== 0) missing.push(rule.join(" "));
  // Where ip6tables exists the same INPUT drops are required (they are best effort in boot.sh, but CI's runner has the tool).
  if ((await run("which", ["ip6tables"])).code === 0) {
    for (const bridge of ["rvb+", "rvi+"]) if ((await sudo("ip6tables", "-C", "INPUT", "-i", bridge, "-j", "DROP")).code !== 0) missing.push(`ip6tables INPUT -i ${bridge} -j DROP`);
  }
  if (missing.length === 0) return;
  const listing = `${(await sudo("iptables", "-S", "DOCKER-USER")).stdout}${(await sudo("iptables", "-S", "INPUT")).stdout}`;
  throw new Error(`the container firewall is not installed (iptables -C finds no "${missing.join('", "')}"): run the "Wall containers off" step of the linux-runtime job first\n${listing}`);
}

/** A TCP server on every address of this host, standing in for the Rovara worker's port. */
export async function listenOnAllAddresses(port = 0): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => socket.end("host\n"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
  return { port: (server.address() as { port: number }).port, server };
}

/**
 * Node source for a container: connects to each target, prints the outcomes as a JSON array (`open`, `timeout`, or the error code), and exits 7 only if every
 * target timed out, which is what a firewall DROP looks like (a refusal or a connection exits 9). `gateway` is the default route's gateway, `bridge` the
 * first address of the on-link network (where a bridge with no default route keeps the host), anything else an address.
 */
export function reachScript(targets: readonly (readonly [host: string, port: number])[]): string {
  return [
    "const n=require('net'),fs=require('fs');",
    "const rows=fs.readFileSync('/proc/net/route','utf8').split('\\n').slice(1).map(l=>l.split('\\t'));",
    "const ip=(h,add)=>{const v=parseInt(h,16);return [v&255,v>>8&255,v>>16&255,(v>>>24)+add].join('.')};",
    "const route=rows.find(f=>f[1]==='00000000'),link=rows.find(f=>f[1]!=='00000000'&&f[2]==='00000000');",
    "const resolve=h=>h==='gateway'?ip(route[2],0):h==='bridge'?ip(link[1],1):h;",
    "const t=(h,p)=>new Promise(o=>{const s=n.connect({host:resolve(h),port:p,timeout:3000});s.on('connect',()=>o('open')).on('timeout',()=>o('timeout')).on('error',e=>o(e.code))});",
    `Promise.all(${JSON.stringify(targets)}.map(([h,p])=>t(h,p))).then(a=>{console.log(JSON.stringify(a));process.exit(a.every(x=>x==='timeout')?7:9)})`,
  ].join("");
}

/** Runs `script` in a throwaway container on `network`, with the same hardening the host gives untrusted containers. */
export async function runNodeIn(network: string, script: string): Promise<Result> {
  return docker("run", "--rm", "--pull=never", "--network", network, "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", script);
}

/** A second routed network behind the host: a veth pair into a namespace that serves TCP on 10.77.1.2. Reaching it from a container takes the FORWARD path. */
export async function startRoutedPrivateServer(port: number): Promise<{ address: string; stop(): Promise<void> }> {
  const steps: string[][] = [
    ["ip", "netns", "add", "rovara-wall"], ["ip", "link", "add", "rvt0", "type", "veth", "peer", "name", "rvt1"], ["ip", "link", "set", "rvt1", "netns", "rovara-wall"],
    ["ip", "addr", "add", "10.77.1.1/24", "dev", "rvt0"], ["ip", "link", "set", "rvt0", "up"],
    ["ip", "netns", "exec", "rovara-wall", "ip", "addr", "add", "10.77.1.2/24", "dev", "rvt1"], ["ip", "netns", "exec", "rovara-wall", "ip", "link", "set", "rvt1", "up"],
    ["ip", "netns", "exec", "rovara-wall", "ip", "link", "set", "lo", "up"], ["ip", "netns", "exec", "rovara-wall", "ip", "route", "add", "default", "via", "10.77.1.1"],
  ];
  let server: ChildProcess | undefined;
  const stop = async () => {
    server?.kill("SIGKILL");
    // Whatever still runs inside the namespace (the node server under sudo) is found by namespace, not by command line.
    const pids = (await sudo("ip", "netns", "pids", "rovara-wall")).stdout.split(/\s+/).filter(Boolean);
    if (pids.length > 0) await sudo("kill", "-9", ...pids);
    await sudo("ip", "netns", "del", "rovara-wall");
    await sudo("ip", "link", "del", "rvt0");
  };
  try {
    await stop();
    for (const step of steps) { const done = await sudo(...step); if (done.code !== 0) throw new Error(`${step.join(" ")} failed: ${done.stderr}`); }
    // The server also ends itself after three minutes, so a test that dies early leaves nothing running.
    const source = `require('net').createServer(s=>s.end('private\\n')).listen(${port},'10.77.1.2');setTimeout(()=>process.exit(0),180000)`;
    server = spawn("sudo", ["-n", "ip", "netns", "exec", "rovara-wall", process.execPath, "-e", source], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return { address: "10.77.1.2", stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
