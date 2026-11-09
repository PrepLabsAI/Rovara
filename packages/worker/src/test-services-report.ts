// Test services, slice 1: the worker's SELF-REPORT. Staging workers are not SSM-managed (their instance profile has no SSM permission, by design), so nobody can run a root command on one. What an operator needs to know about a
// worker's test services is therefore logged by the worker itself, as ONE structured line (to the worker's CloudWatch log group, which the container's log driver already feeds), and read with `aws logs filter-log-events`
// through the staging guard (scripts/staging-test-services-e2e.sh).
//
// When: after every test-services run ends (completed, failed or cancelled: `phase: "run_end"`), and once at the worker's start, after the leftover sweep (`phase: "worker_start"`, with the facts root wrote at boot).
// What: fixed fields only (counts, booleans, small fixed words and the boot facts). No name of a container, network, image or file, no path, no environment value, no command output, no secret: `reportLine` checks its own
// output against the schema (`checkReport`) and a line that does not pass is not written.
//
//   leftoverContainers / leftoverNetworks   how many containers and networks still carry the run-network label of this workspace (zero after a clean teardown; a killed worker's are removed by the next start; null: Docker
//                                           could not be asked, which is NOT the same as zero and fails the done-check)
//   runDirEmpty                             the run directory (a tmpfs the worker was given) holds nothing
//   runDirTmpfs                             that directory really is a tmpfs mount inside the worker (null: the mount table could not be read)
//   workingSandboxPaused                    the task's working sandbox is NOT frozen after the run (false is right; true means a pause was left behind; null: no sandbox, or it is gone)
//   bootFacts                               root's facts from boot (`AGENTX_TEST_SERVICES_BOOT_FACTS`): the metadata block, the run-network walls, the IPv6 drops, the pre-pull and the registry logout
import { readFile, readdir } from "node:fs/promises";
import { RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL } from "./run-network.js";
import type { DockerCli } from "./swebench/containers.js";

export const TEST_SERVICES_REPORT_EVENT = "test-services.report";
export const TEST_SERVICES_BOOT_FACTS_ENVIRONMENT = "AGENTX_TEST_SERVICES_BOOT_FACTS";
export type ReportPhase = "run_end" | "worker_start";
/**
 * completed:     the run ended and no check command in any round ended non-zero or timed out;
 * checks_failed: the run itself worked, but at least one check command of a sealed round ended non-zero or timed out (a failed check, not a broken environment);
 * failed:        the run could not start (dependencies, seeds, a round);
 * cancelled:     the run was stopped;
 * booted:        the `worker_start` line.
 */
export type ReportOutcome = "completed" | "checks_failed" | "failed" | "cancelled" | "booted";

/** What root wrote at boot (boot-stage2.sh `write_test_services_boot_facts`). Booleans and small fixed words only. */
export interface BootFacts {
  metadataBlocked: boolean;
  runWalls: boolean;
  ipv6Drops: boolean;
  /** Only when `ipv6Drops` is false: why (boot-stage2.sh `IPV6_WALL_REASON`). The worker then runs without test services (AGENTX_TEST_SERVICES_NOT_PULLED=all). */
  ipv6DropsReason?: "ip6tables-unusable" | "rule-not-added";
  /** `none`: the image pins nothing to pull; `off`: test services (`tx`) are off for this launch, so nothing was read, logged in or pulled; `ok`: every pinned digest is on the host; `partial`: some digests are on the host and the rest are named in AGENTX_TEST_SERVICES_NOT_PULLED (not offered; the done-check still wants `ok`); `failed`: the login failed or no digest arrived. */
  prepull: "none" | "off" | "ok" | "partial" | "failed";
  prepulled: number;
  /** The registry login was removed after the pulls. */
  loggedOut: boolean;
  dockerVersion: string;
}

export interface TestServicesReport {
  phase: ReportPhase;
  outcome: ReportOutcome;
  leftoverContainers: number | null;
  leftoverNetworks: number | null;
  runDirEmpty: boolean | null;
  runDirTmpfs: boolean | null;
  workingSandboxPaused: boolean | null;
  /** worker_start: what the sweep removed. */
  sweptContainers?: number;
  sweptNetworks?: number;
  /** worker_start: root's boot facts, "absent" when the worker was not given any, "unreadable" when they were not in the expected form. */
  bootFacts?: BootFacts | "absent" | "unreadable";
}

const COUNT_MAX = 100_000;
const FACT_KEYS: ReadonlyArray<keyof BootFacts> = ["metadataBlocked", "runWalls", "ipv6Drops", "prepull", "prepulled", "loggedOut", "dockerVersion"];

/** The boot facts in `text`, or "unreadable" when they are not exactly the expected shape. */
export function parseBootFacts(text: string | undefined): BootFacts | "absent" | "unreadable" {
  if (text === undefined || text === "") return "absent";
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return "unreadable"; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unreadable";
  const facts = parsed as Record<string, unknown>;
  const keys = Object.keys(facts);
  const reason = facts["ipv6DropsReason"];
  const hasReason = keys.includes("ipv6DropsReason");
  if (keys.length !== FACT_KEYS.length + (hasReason ? 1 : 0) || !FACT_KEYS.every((key) => keys.includes(key))) return "unreadable";
  if (hasReason && (facts["ipv6Drops"] !== false || (reason !== "ip6tables-unusable" && reason !== "rule-not-added"))) return "unreadable";
  const bool = (value: unknown): value is boolean => typeof value === "boolean";
  if (!bool(facts["metadataBlocked"]) || !bool(facts["runWalls"]) || !bool(facts["ipv6Drops"]) || !bool(facts["loggedOut"])) return "unreadable";
  if (facts["prepull"] !== "none" && facts["prepull"] !== "off" && facts["prepull"] !== "ok" && facts["prepull"] !== "partial" && facts["prepull"] !== "failed") return "unreadable";
  if (typeof facts["prepulled"] !== "number" || !Number.isInteger(facts["prepulled"]) || facts["prepulled"] < 0 || facts["prepulled"] > 64) return "unreadable";
  if (typeof facts["dockerVersion"] !== "string" || !/^[0-9]{1,3}(?:\.[0-9]{1,3}){0,3}(?:-[a-z0-9.]{1,12})?$/u.test(facts["dockerVersion"])) return "unreadable";
  return { metadataBlocked: facts["metadataBlocked"], runWalls: facts["runWalls"], ipv6Drops: facts["ipv6Drops"], ...(reason === "ip6tables-unusable" || reason === "rule-not-added" ? { ipv6DropsReason: reason } : {}), prepull: facts["prepull"], prepulled: facts["prepulled"], loggedOut: facts["loggedOut"], dockerVersion: facts["dockerVersion"] };
}

const REPORT_KEYS: ReadonlySet<string> = new Set(["phase", "outcome", "leftoverContainers", "leftoverNetworks", "runDirEmpty", "runDirTmpfs", "workingSandboxPaused", "sweptContainers", "sweptNetworks", "bootFacts"]);
const count = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= COUNT_MAX;
const countOrNull = (value: unknown): boolean => value === null || count(value);
const tri = (value: unknown): boolean => value === null || typeof value === "boolean";

/** True when `value` is exactly a report: only the known keys, counts and booleans of the right kinds. */
export function checkReport(value: unknown): value is TestServicesReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (!Object.keys(report).every((key) => REPORT_KEYS.has(key))) return false;
  if (report["phase"] !== "run_end" && report["phase"] !== "worker_start") return false;
  if (!["completed", "checks_failed", "failed", "cancelled", "booted"].includes(report["outcome"] as string)) return false;
  if (!countOrNull(report["leftoverContainers"]) || !countOrNull(report["leftoverNetworks"]) || !tri(report["runDirEmpty"]) || !tri(report["runDirTmpfs"]) || !tri(report["workingSandboxPaused"])) return false;
  if (report["sweptContainers"] !== undefined && !count(report["sweptContainers"])) return false;
  if (report["sweptNetworks"] !== undefined && !count(report["sweptNetworks"])) return false;
  const facts = report["bootFacts"];
  if (facts !== undefined && facts !== "absent" && facts !== "unreadable" && parseBootFacts(JSON.stringify(facts)) === "unreadable") return false;
  return true;
}

/** The log line for a report, or undefined when it is not a valid report (nothing is written then). */
export function reportLine(report: TestServicesReport): Record<string, unknown> | undefined {
  return checkReport(report) ? { event: TEST_SERVICES_REPORT_EVENT, ...report } : undefined;
}

export interface ReportInput {
  docker: DockerCli;
  /** `setupWorkspaceKey(root)`: the workspace label the run-network objects carry. */
  workspace: string;
  /** The run directory parent (a tmpfs the worker was given), or undefined when there is none. */
  runDirectoryParent?: string | undefined;
  /** The task's working sandbox, when there is one. */
  sandboxName?: string | undefined;
  phase: ReportPhase;
  outcome: ReportOutcome;
  swept?: { containers: number; networks: number } | undefined;
  bootFactsText?: string | undefined;
  /** Test seams. */
  readMountTable?: () => Promise<string>;
  readDirectory?: (path: string) => Promise<string[]>;
}

const ofLines = (stdout: string): number => stdout.split("\n").filter((line) => line.trim() !== "").length;

/** Looks (read-only) at what is left, and builds the report. Every look that fails gives null; this never throws. */
export async function collectReport(input: ReportInput): Promise<TestServicesReport> {
  const filters = ["--filter", `label=${RUN_NETWORK_LABEL}`, "--filter", `label=${RUN_NETWORK_WORKSPACE_LABEL}=${input.workspace}`];
  // A look that fails is null ("could not look"), never zero: an unanswered question must not read as a clean worker.
  const list = async (args: string[]): Promise<number | null> => {
    const result = await input.docker.run(args, { timeoutMs: 30_000 }).catch(() => undefined);
    return result === undefined || result.exitCode !== 0 ? null : ofLines(result.stdout);
  };
  const leftoverContainers = await list(["ps", "-a", ...filters, "--format", "{{.ID}}"]);
  const leftoverNetworks = await list(["network", "ls", ...filters, "--format", "{{.ID}}"]);
  let runDirEmpty: boolean | null = null;
  let runDirTmpfs: boolean | null = null;
  if (input.runDirectoryParent !== undefined) {
    runDirEmpty = await (input.readDirectory ?? readdir)(input.runDirectoryParent).then((names) => names.length === 0, () => null);
    const table = await (input.readMountTable ?? (() => readFile("/proc/self/mountinfo", "utf8")))().catch(() => undefined);
    runDirTmpfs = table === undefined ? null : table.split("\n").some((line) => {
      const [before, after] = line.split(" - ");
      return before?.split(" ")[4] === input.runDirectoryParent && after?.startsWith("tmpfs ") === true;
    });
  }
  let workingSandboxPaused: boolean | null = null;
  if (input.sandboxName !== undefined) {
    const inspected = await input.docker.run(["inspect", "--format", "{{.State.Paused}}", input.sandboxName], { timeoutMs: 30_000 }).catch(() => undefined);
    const text = inspected?.exitCode === 0 ? inspected.stdout.trim() : "";
    workingSandboxPaused = text === "true" ? true : text === "false" ? false : null;
  }
  return {
    phase: input.phase, outcome: input.outcome, leftoverContainers, leftoverNetworks, runDirEmpty, runDirTmpfs, workingSandboxPaused,
    ...(input.swept === undefined ? {} : { sweptContainers: input.swept.containers, sweptNetworks: input.swept.networks }),
    ...(input.phase === "worker_start" ? { bootFacts: parseBootFacts(input.bootFactsText) } : {}),
  };
}

/** Collects and writes the report through `log`. Never throws. */
export async function emitReport(input: ReportInput, log: (event: Record<string, unknown>) => void): Promise<void> {
  try {
    const line = reportLine(await collectReport(input));
    if (line !== undefined) log(line);
  } catch {
    // A report is a courtesy: it never fails a run.
  }
}
