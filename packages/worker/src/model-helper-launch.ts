// TE-F1b (M2, release 0.5.19; te-f1 design 2.2 and 3.2): the `docker run` arguments of the MODEL HELPER, one container per task (or per round) on that task's own `rvi` run network at .9. The helper is a container from the WORKER'S OWN IMAGE
// running `node dist/model-helper.js` (TE-F2's program; this lane builds only the network, the launch and the 443/80 recorder), like the sealed DNS helper and the fake helper.
//
// What the helper is allowed, and what it is not (each rule is checked twice: when the arguments are built, and by `modelHelperArgProblems`, which reads them back):
//   - ONE network, the run's own (`rvi` bridge, internal: nothing leaves it, other `rvi` bridges are unreachable, the host is dropped for IPv4 and IPv6 by the boot walls). No egress network, no published port, no `--add-host`, and
//     no DNS upstream: `--dns 127.0.0.1` gives Docker's embedded resolver (127.0.0.11) only the helper's own loopback to forward to, where nothing listens.
//   - no capability (`--cap-drop ALL`, no `--cap-add`), `no-new-privileges`, a non-root user, a READ-ONLY root.
//   - ONE bind mount, read-only: a directory of the worker's that holds only the helper's own files (the rows, the replies, the bridge's Unix socket), and ONE tmpfs for the ledger (TE-F2/R1 need a place to write that is not the
//     worker's). `MODEL_HELPER_RUN_DIR` and `MODEL_HELPER_LEDGER_DIR` are the paths TE-F2's program reads (`model-helper-args.ts`).
//   - it listens on its own address (.9) and serves ONE sandbox address (.3 for the working sandbox, .4 for a round's fresh check sandbox), through the program's own `--listen` and `--caller` flags.
//   - ALL four labels of the run network on the container (the sweep and `stop()` find a container only by them; run-network.ts rule 1).
// The program's own arguments come from the caller (TE-F2's `modelHelperArgs`); this module only checks that they listen on .9 and serve exactly the sandbox's address, and that no argument could carry anything but a word. Pure.
import { isIP } from "node:net";
import { agentXError } from "@agentx/contracts";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, runNetworkModelHelperIp, type ServicesNetwork } from "./run-network.js";

/** Where the helper finds the worker's run files, read-only (the rows, the replies, and later the bridge's socket). */
export const MODEL_HELPER_RUN_DIR = "/rovara/models";
/** The helper's own tmpfs: the ledger and the capture file. Never the worker's. */
export const MODEL_HELPER_LEDGER_DIR = "/rovara/ledger";
/** Where the worker image keeps the helper's program (environments/base/Dockerfile copies the worker's dist). */
export const MODEL_HELPER_ENTRY = "/opt/agentx/packages/worker/dist/model-helper.js";
const NODE = "/usr/local/bin/node";
const HELPER_USER = "1000:1000";
/** The one DNS server the helper is given: its own loopback, so the embedded resolver has no upstream to forward to. */
const NO_UPSTREAM_DNS = "127.0.0.1";
/** The helper binds 443 and 80 (the recorder) as a non-root user: nothing below 80. */
const PORT_SYSCTL = "net.ipv4.ip_unprivileged_port_start=80";
const MEMORY = "128m";
const CPUS = "0.5";
const PIDS = "64";
const LEDGER_TMPFS = `${MODEL_HELPER_LEDGER_DIR}:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000`;
const NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/u;
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u;
const RUN_DIR_PATH = /^\/[A-Za-z0-9_./-]{1,500}$/u;
const WORD = /^[\x21-\x7e]{1,256}$/u;
const LABEL_KEYS: readonly string[] = [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL];

export type ModelHelperLaunchNetwork = Pick<ServicesNetwork, "name" | "slot" | "workingSandboxIp" | "checkSandboxIp" | "labelArgs">;

export interface ModelHelperLaunchInput {
  net: ModelHelperLaunchNetwork;
  /** The worker's own image (it carries `dist/model-helper.js`). */
  image: string;
  /** The worker's directory for the helper's files: an absolute plain path whose last segment is `models`, holding nothing but the helper's own files. */
  runDir: string;
  /** The one sandbox address the helper serves: .3 of the network (working sandbox) or .4 (a round's check sandbox). */
  sandboxIp: string;
  /** The program's own arguments (TE-F2's `modelHelperArgs`): they must listen on .9 and serve exactly `sandboxIp`. */
  programArgs: readonly string[];
}

/** The helper container's name: the network's own name and `-models`. */
export const modelHelperContainerName = (net: Pick<ServicesNetwork, "name">): string => `${net.name}-models`;

function assertInput(input: ModelHelperLaunchInput): void {
  const bad = (what: string): never => {
    throw agentXError("CONFIG_INVALID", `not ${what} for the model helper`);
  };
  if (!NETWORK_NAME.test(input.net.name)) bad("a run network");
  if (!IMAGE_REFERENCE.test(input.image)) bad("an image");
  if (!RUN_DIR_PATH.test(input.runDir) || input.runDir.includes("//") || input.runDir.split("/").some((segment) => segment === ".." || segment === ".") || input.runDir.split("/").at(-1) !== "models") bad("a run directory");
  if (isIP(input.sandboxIp) !== 4 || (input.sandboxIp !== input.net.workingSandboxIp && input.sandboxIp !== input.net.checkSandboxIp)) bad("a sandbox address");
  if (!input.programArgs.every((arg) => WORD.test(arg))) bad("a program argument");
}

function valuesOf(list: readonly string[], flag: string): string[] {
  return list.flatMap((arg, index) => (list[index - 1] === flag ? [arg] : []));
}

/** The `docker run` arguments of the model helper. Throws CONFIG_INVALID (a fixed sentence) when an input is not plain or the result would not pass `modelHelperArgProblems`. */
export function modelHelperRunArgs(input: ModelHelperLaunchInput): string[] {
  assertInput(input);
  const { net } = input;
  const args = [
    "run", "--detach", "--pull=never", "--name", modelHelperContainerName(net), "--stop-timeout", "1", ...net.labelArgs(),
    "--network", net.name, "--ip", runNetworkModelHelperIp(net.slot), "--dns", NO_UPSTREAM_DNS,
    "--user", HELPER_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--sysctl", PORT_SYSCTL,
    "--memory", MEMORY, "--memory-swap", MEMORY, "--cpus", CPUS, "--pids-limit", PIDS, "--log-driver", "none",
    "--volume", `${input.runDir}:${MODEL_HELPER_RUN_DIR}:ro`,
    "--tmpfs", LEDGER_TMPFS,
    "--entrypoint", NODE,
    input.image, MODEL_HELPER_ENTRY, ...input.programArgs,
  ];
  const problems = modelHelperArgProblems(args, net, { sandboxIp: input.sandboxIp });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", `the model helper's arguments are unsound: ${problems.join("; ")}`);
  return args;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--name", "--label", "--network", "--ip", "--dns", "--user", "--cap-drop", "--security-opt", "--sysctl", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--log-driver", "--volume", "--tmpfs", "--entrypoint", "--stop-timeout"]);
const SINGLE_FLAGS: ReadonlySet<string> = new Set(["--detach", "--pull=never", "--read-only"]);

/**
 * Reads a model helper's `docker run` arguments back and names every way they are unsound, in fixed words (no value is repeated). An empty list is a sound set. Allow-list: a flag that is not one the helper takes is a problem,
 * so a new way to reach the network, the host or a second mount cannot be added by accident.
 */
export function modelHelperArgProblems(args: readonly string[], net: ModelHelperLaunchNetwork, expected: { sandboxIp: string }): string[] {
  const problems: string[] = [];
  const flags = new Map<string, string[]>();
  let at = 0;
  if (args[at] !== "run") problems.push("it is not a docker run");
  else at += 1;
  let image: string | undefined;
  while (at < args.length) {
    const token = args[at]!;
    if (SINGLE_FLAGS.has(token)) { flags.set(token, [...(flags.get(token) ?? []), ""]); at += 1; continue; }
    if (VALUE_FLAGS.has(token)) {
      const value = args[at + 1];
      if (value === undefined || value.startsWith("-")) { problems.push("a flag has no value"); at += 1; continue; }
      flags.set(token, [...(flags.get(token) ?? []), value]);
      at += 2;
      continue;
    }
    if (token.startsWith("-")) { problems.push("a flag the model helper does not take"); at += 1; continue; }
    image = token;
    at += 1;
    break;
  }
  const only = (flag: string, wanted: string): boolean => (flags.get(flag) ?? []).length === 1 && flags.get(flag)![0] === wanted;
  if (image === undefined) problems.push("there is no image");
  if ((flags.get("--network") ?? []).length !== 1 || flags.get("--network")![0] !== net.name) problems.push("the helper must be on the run network and on no other network");
  if (!only("--dns", NO_UPSTREAM_DNS)) problems.push("the helper's only DNS server must be its own loopback (no upstream)");
  if (!only("--ip", runNetworkModelHelperIp(net.slot))) problems.push("the helper must have the run's model helper address");
  if (!only("--cap-drop", "ALL") || (flags.get("--cap-drop") ?? []).length !== 1) problems.push("the helper must drop every capability");
  if (!flags.has("--read-only")) problems.push("the helper's root must be read-only");
  if (!only("--security-opt", "no-new-privileges")) problems.push("the helper must have no-new-privileges and no other security option");
  if (!only("--user", HELPER_USER)) problems.push("the helper must run as the non-root user");
  if (!only("--sysctl", PORT_SYSCTL)) problems.push("the helper takes one sysctl, the unprivileged port start");
  if (!only("--entrypoint", NODE)) problems.push("the helper must start the worker's node");
  if (!only("--tmpfs", LEDGER_TMPFS)) problems.push("the helper has one tmpfs, the ledger's");
  const volumes = flags.get("--volume") ?? [];
  if (volumes.length !== 1 || !volumes[0]!.endsWith(`:${MODEL_HELPER_RUN_DIR}:ro`)) problems.push("the helper has exactly one mount, the run directory, mounted read-only");
  const labelKeys = (flags.get("--label") ?? []).map((label) => label.split("=")[0]!);
  if (LABEL_KEYS.some((key) => labelKeys.filter((candidate) => candidate === key).length !== 1) || labelKeys.length !== LABEL_KEYS.length) problems.push("the helper must carry all four labels of the run network, once each");
  const rest = image === undefined ? [] : args.slice(at);
  if (rest[0] !== MODEL_HELPER_ENTRY) problems.push("the helper must run the model helper program");
  const program = rest.slice(1);
  if (valuesOf(program, "--listen").length !== 1 || valuesOf(program, "--listen")[0] !== runNetworkModelHelperIp(net.slot)) problems.push("the program must listen on the helper's own address and nothing else");
  if (valuesOf(program, "--caller").length !== 1 || valuesOf(program, "--caller")[0] !== expected.sandboxIp) problems.push("the program must serve exactly the sandbox's address");
  if (!program.every((arg) => WORD.test(arg))) problems.push("a program argument is not a plain word");
  return problems;
}
