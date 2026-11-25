// A small stateful fake Docker daemon for the sealed eval round with services and the sealed name server (L4-E12). Nothing starts Docker. It answers what `createFreshEvalSandbox`, `startModelHelper`, `startHelpers` and the
// sealed name server's start use (network create/rm/ls/inspect, run, inspect, exec, logs, wait, pause, unpause, ps, rm, image inspect), keeps each container's network, address, mounts and arguments from its own `docker run`
// arguments, plays the eval when the sandbox is waited on (its output is what `docker logs` then says) and answers a NETWORK QUESTION from the arguments alone: which addresses can a container reach (`reachableFrom`)? That is a
// model of Docker's rules for an `--internal` bridge (only members of the same network, no route out), so "the box reaches Postgres and nothing else" is checked against what the arguments said, not against a promise.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

export const EVAL_REPORT_FILE = "eval-report.json";
export interface FakeContainer { id: string; name: string; labels: Record<string, string>; network: string; ip: string; args: string[]; mounts: { Source: string; Destination: string; RW: boolean; Type: string }[]; paused: boolean; aliases: string[] }
export interface FakeNetwork { name: string; labels: Record<string, string>; internal: boolean; subnet: string }
export interface EvalDaemonOptions {
  /** What the eval prints (stdout and stderr), by the env file it was started with. Default: nothing. */
  readonly output?: (env: string, checkout: string) => string;
  /** The eval's exit code (default 0). When 0 the report file is written. */
  readonly exitCode?: number;
  /** The sealed name server's record (`/state/unknown.json`): the unknown names it was asked. */
  readonly dnsUnknown?: readonly string[];
  /** A `docker run` whose arguments this returns true for fails (exit 1). */
  readonly failRun?: (args: readonly string[]) => boolean;
}

export function fakeEvalDaemon(options: EvalDaemonOptions = {}) {
  const networks: FakeNetwork[] = [];
  const containers: FakeContainer[] = [];
  const everStarted: FakeContainer[] = [];
  const calls: string[][] = [];
  /** The content of each env file at the moment of its `docker run` (the worker removes it right after). */
  const envFiles: Array<{ container: string; content: string }> = [];
  /** The content of each bind-mounted regular file at its `docker run` (resolv.conf, hosts). */
  const mountedFiles: Array<{ container: string; destination: string; content: string }> = [];
  /** The model helper's run files (`rows.json`, `replies.json`) at the moment its container started (the worker removes them when the run ends). */
  const helperFiles: Array<{ container: string; rows: string; replies: string }> = [];
  let ids = 0;
  const values = (args: readonly string[], flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
  const labelsOf = (args: readonly string[]) => Object.fromEntries(values(args, "--label").map((arg) => arg.split(/=(.*)/su).slice(0, 2) as [string, string]));
  const ok = (stdout = "") => Promise.resolve({ exitCode: 0, stdout, stderr: "" });
  const fail = (stderr = "error") => Promise.resolve({ exitCode: 1, stdout: "", stderr });
  const find = (name: string) => containers.find((c) => c.name === name || c.id === name);
  let lastOutput = "";
  const docker: DockerCli = {
    async run(args) {
      calls.push([...args]);
      const [a, b] = args;
      if (a === "network" && b === "create") { const name = args.at(-1)!; if (networks.some((n) => n.name === name)) return fail(); networks.push({ name, labels: labelsOf(args), internal: args.includes("--internal"), subnet: values(args, "--subnet")[0] ?? "" }); return ok(); }
      if (a === "network" && b === "ls") return ok("");
      if (a === "network" && b === "inspect") return fail("No such network");
      if (a === "network" && b === "rm") { const index = networks.findIndex((n) => n.name === args[2]); if (index < 0) return fail("No such network"); if (containers.some((c) => c.network === networks[index]!.name)) return fail("active endpoints"); networks.splice(index, 1); return ok(); }
      if (a === "image" && b === "inspect") return ok(args.includes("{{json .Config.Volumes}}") ? "null\n" : "sha256:present\n");
      if (a === "run") {
        if (options.failRun?.(args) === true) return fail("run failed");
        const name = values(args, "--name")[0] ?? `probe-${String(++ids)}`;
        const networkArg = values(args, "--network")[0] ?? "";
        // A probe or a guard runs `--rm` in the foreground and is gone; it needs a network that exists.
        if (args.includes("--rm")) return ok();
        if (!networks.some((n) => n.name === networkArg)) return fail("no network");
        const mounts = [
          ...values(args, "--volume").map((v) => { const [Source, Destination, mode] = v.split(":"); return { Source: Source!, Destination: Destination!, RW: mode !== "ro", Type: "bind" }; }),
          ...values(args, "--tmpfs").map((v) => ({ Source: "", Destination: v.split(":")[0]!, RW: true, Type: "tmpfs" })),
        ];
        for (const file of values(args, "--env-file")) envFiles.push({ container: name, content: readFileSync(file, "utf8") });
        for (const mount of mounts) {
          if (mount.Type !== "bind" || !["/etc/resolv.conf", "/etc/hosts"].includes(mount.Destination)) continue;
          mountedFiles.push({ container: name, destination: mount.Destination, content: readFileSync(mount.Source, "utf8") });
        }
        for (const mount of mounts) {
          if (mount.Type === "bind" && mount.Destination === "/rovara/models") helperFiles.push({ container: name, rows: readFileSync(join(mount.Source, "rows.json"), "utf8"), replies: readFileSync(join(mount.Source, "replies.json"), "utf8") });
        }
        const container: FakeContainer = { id: `c${String(++ids)}`, name, labels: labelsOf(args), network: networkArg, ip: values(args, "--ip")[0] ?? "", args: [...args], mounts, paused: false, aliases: values(args, "--network-alias") };
        containers.push(container);
        everStarted.push(container);
        return ok(container.id);
      }
      if (a === "inspect") {
        const container = find(args.at(-1)!);
        if (container === undefined) return fail("No such object");
        const template = values(args, "--format")[0] ?? "";
        if (template.includes("{{.State.Running}}")) return ok(`true|${JSON.stringify({ [container.network]: { IPAddress: container.ip } })}`);
        if (template.includes("{{.State.Status}}")) return ok("running");
        if (template.includes("{{json .Mounts}}")) return ok(JSON.stringify(container.mounts));
        if (template.includes("{{.State.Paused}}")) return ok(String(container.paused));
        return ok(JSON.stringify({ [container.network]: { IPAddress: container.ip } }));
      }
      if (a === "exec") {
        const container = find(args[1]!);
        if (container === undefined) return fail("No such container");
        if (args.includes("/state/unknown.json")) return ok(JSON.stringify({ unknown: (options.dnsUnknown ?? []).map((name) => ({ name, queries: 1 })), dropped: 0, unrecorded: 0 }));
        return ok();
      }
      if (a === "logs") return ok(lastOutput);
      if (a === "wait") {
        const container = find(args[1]!);
        if (container === undefined) return fail("No such container");
        const checkout = container.mounts.find((m) => m.Destination === "/workspace")!.Source;
        const env = envFiles.filter((file) => file.container === container.name).at(-1)?.content ?? "";
        lastOutput = options.output?.(env, checkout) ?? "";
        const code = options.exitCode ?? 0;
        if (code === 0) await writeFile(join(checkout, EVAL_REPORT_FILE), JSON.stringify({ measures: { version: 1 } }));
        return ok(String(code));
      }
      if (a === "pause" || a === "unpause") return ok();
      if (a === "ps") {
        const filter = values(args, "--filter").find((f) => f.startsWith("label=rovara.run-network="));
        const wanted = filter?.split("=")[2];
        const template = values(args, "--format")[0] ?? "{{.ID}}";
        return ok(containers.filter((c) => wanted === undefined || c.labels["rovara.run-network"] === wanted)
          .map((c) => template.replace(/\{\{\.ID\}\}/gu, c.id).replace(/\{\{\.Label "([^"]+)"\}\}/gu, (_all, key: string) => c.labels[key] ?? "")).join("\n"));
      }
      if (a === "rm") {
        for (const target of args.slice(1).filter((arg) => !arg.startsWith("-"))) { const index = containers.findIndex((c) => c.id === target || c.name === target); if (index >= 0) containers.splice(index, 1); }
        return ok();
      }
      return ok();
    },
  };
  /**
   * What a container can reach, from the daemon's own state: the addresses of the OTHER containers on the SAME network, and only when that network is `--internal` (no route out, no gateway, no host) and the container has no second network.
   * `null` for a container that is on no round network. A published port, a second `--network`, a host or default-bridge network make the answer `"anything"`: those are the escapes this model exists to catch.
   */
  const reachableFrom = (name: string): string[] | "anything" => {
    const container = everStarted.find((c) => c.name === name)!;
    const networkFlags = container.args.filter((arg, index) => container.args[index - 1] === "--network");
    const published = container.args.some((arg) => ["-p", "--publish", "-P", "--publish-all", "--expose"].includes(arg));
    const net = networks.find((n) => n.name === container.network) ?? { internal: true };
    if (published || networkFlags.length !== 1 || !net.internal || ["host", "bridge"].includes(container.network)) return "anything";
    return everStarted.filter((c) => c.network === container.network && c.name !== name && c.ip !== "").map((c) => c.ip);
  };
  return { docker, networks, containers, everStarted, calls, envFiles, mountedFiles, helperFiles, reachableFrom, find, waits: () => calls.filter((call) => call[0] === "wait").length };
}
