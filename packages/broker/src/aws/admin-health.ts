// Spec 025 A13: the health answer. Every probe has a time limit and answers `unknown` with a reason
// when it is not set up or fails, so the route itself never fails for a probe. Details carry
// counts, names, codes and error classes only.
import { ADMIN_API_VERSION, DEVELOPER_API_VERSION, type AdminHealthCheck, type AdminHealthResponse, type SlackAuthCheckResponse } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import { adminProjects, projectWorkspaceRows, readFailures, type AdminReadDependencies } from "./admin-reads.js";

/** Function-valued fields, not methods, so a probe can be called on its own (no `this`). */
export interface AdminHealthProbes {
  release?: string;
  alarms?: () => Promise<Array<{ name: string; state: string }>>;
  queueDepths?: () => Promise<Array<{ name: string; depth: number | null }>>;
  slackAuthCheck?: () => Promise<SlackAuthCheckResponse>;
  githubInstallations?: () => Promise<number>;
  timeoutMs?: number;
}

/** A13: each probe's time limit. */
const PROBE_TIMEOUT_MS = 3_000;
/** A project's workspaces read for the status counts; more marks the counts truncated. */
const WORKSPACE_COUNT_CAP = 1_000;
/** An error class is a short identifier; the cap keeps a detail inside the contract's 300 characters. */
const ERROR_NAME_MAX = 100;

class ProbeTimeout extends Error {}
const errorName = (error: unknown) => (error instanceof Error ? error.name.slice(0, ERROR_NAME_MAX) : "unknown");
const NOT_SET_UP: AdminHealthCheck = { status: "unknown", detail: "not set up in this deployment" };

async function within<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProbeTimeout()), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
const failed = (what: string, ms: number, error: unknown): AdminHealthCheck => (error instanceof ProbeTimeout
  ? { status: "unknown", detail: `did not answer within ${ms / 1000} seconds` }
  : { status: "unknown", detail: `could not read ${what} (${errorName(error)})` });

const queueCount = (count: number) => `${count} queue${count === 1 ? "" : "s"}`;
/**
 * R18: messages waiting in any queue warn (naming how many could not be read as well); otherwise
 * a queue whose depth could not be read makes the check unknown; otherwise all are empty.
 */
function queuesCheck(depths: ReadonlyArray<{ depth: number | null }>): AdminHealthCheck {
  const holding = depths.filter((queue) => queue.depth !== null && queue.depth > 0).length;
  const unread = depths.filter((queue) => queue.depth === null).length;
  if (holding > 0) return { status: "warn", detail: `${queueCount(holding)} ${holding === 1 ? "holds" : "hold"} messages${unread === 0 ? "" : `; ${unread} could not be read`}` };
  if (unread > 0) return { status: "unknown", detail: `${unread} of ${queueCount(depths.length)} could not be read` };
  return { status: "ok", detail: `${queueCount(depths.length)}, all empty` };
}

export async function adminHealth(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<AdminHealthResponse> {
  const probes: AdminHealthProbes = deps.health ?? {};
  const ms = probes.timeoutMs ?? PROBE_TIMEOUT_MS;
  const now = deps.now();

  const alarmsPart = async (): Promise<Pick<AdminHealthResponse, "alarms" | "alarmsCheck">> => {
    if (probes.alarms === undefined) return { alarms: [], alarmsCheck: NOT_SET_UP };
    try {
      const alarms = [...await within(ms, probes.alarms)].sort((left, right) => left.name.localeCompare(right.name));
      const firing = alarms.filter((alarm) => alarm.state === "ALARM").length;
      return { alarms, alarmsCheck: firing === 0 ? { status: "ok", detail: `${alarms.length} alarms, none in ALARM` } : { status: "warn", detail: `${firing} alarm${firing === 1 ? "" : "s"} in ALARM` } };
    } catch (error) {
      return { alarms: [], alarmsCheck: failed("the alarms", ms, error) };
    }
  };
  const queuesPart = async (): Promise<Pick<AdminHealthResponse, "deadLetterQueues" | "deadLetterQueuesCheck">> => {
    if (probes.queueDepths === undefined) return { deadLetterQueues: [], deadLetterQueuesCheck: NOT_SET_UP };
    try {
      const depths = await within(ms, probes.queueDepths);
      return { deadLetterQueues: depths, deadLetterQueuesCheck: queuesCheck(depths) };
    } catch (error) {
      return { deadLetterQueues: [], deadLetterQueuesCheck: failed("the dead-letter queues", ms, error) };
    }
  };
  const slackPart = async (): Promise<AdminHealthCheck> => {
    if (probes.slackAuthCheck === undefined) return NOT_SET_UP;
    try {
      const answer = await within(ms, probes.slackAuthCheck);
      if (answer.ok) {
        // R17: a token that works for another workspace is the wrong token for this environment.
        if (deps.slackTeamId !== undefined && answer.teamId !== deps.slackTeamId) {
          return { status: "failed", detail: `the bot token belongs to team ${answer.teamId}, not this environment's team ${deps.slackTeamId}` };
        }
        return { status: "ok", detail: `the bot token works for team ${answer.teamId}` };
      }
      return answer.error === "slack_unavailable" ? { status: "unknown", detail: "Slack could not be reached" } : { status: "failed", detail: `Slack refused the bot token (${answer.error})` };
    } catch (error) {
      return failed("Slack", ms, error);
    }
  };
  const githubPart = async (): Promise<AdminHealthCheck> => {
    if (probes.githubInstallations === undefined) return NOT_SET_UP;
    try {
      const count = await within(ms, probes.githubInstallations);
      return count === 0 ? { status: "failed", detail: "the GitHub App is installed on no account" } : { status: "ok", detail: `installed on ${count} account${count === 1 ? "" : "s"}` };
    } catch (error) {
      return failed("the GitHub App", ms, error);
    }
  };
  const statePart = async (): Promise<Pick<AdminHealthResponse, "workerModes" | "workspaces" | "workspacesTruncated">> => {
    const projects = await adminProjects(deps, identity);
    const modes = new Set(projects.map((project) => project.latest.runtimeBinding.deploymentMode));
    const reads = await Promise.all(projects.map((project) => projectWorkspaceRows(deps, project.name, WORKSPACE_COUNT_CAP)));
    const workspaces: Record<string, number> = {};
    const workspacesTruncated = reads.some((read) => read.truncated);
    for (const { rows } of reads) for (const row of rows) if (row.status !== "CLOSED") workspaces[row.status] = (workspaces[row.status] ?? 0) + 1;
    const window = { since: new Date(now - 86_400_000).toISOString(), until: new Date(now).toISOString() };
    const [latest] = (await readFailures(deps, window, { limit: 1, category: "worker_unavailable" })).failures;
    // FR-024: ec2-ebs is the only worker mode; it is configured when a project's latest revision binds it.
    return {
      workerModes: [{ mode: "ec2-ebs", configured: modes.has("ec2-ebs"), ...(latest === undefined ? {} : { latestDispatchFailure: { at: latest.endedAt, operationId: latest.operationId, error: latest.error } }) }],
      workspaces, workspacesTruncated,
    };
  };

  const [alarms, deadLetterQueues, slack, github, state] = await Promise.all([alarmsPart(), queuesPart(), slackPart(), githubPart(), statePart()]);
  return {
    version: { developerApi: DEVELOPER_API_VERSION, adminApi: ADMIN_API_VERSION, ...(probes.release === undefined ? {} : { release: probes.release }) },
    ...alarms, ...deadLetterQueues, slack, github, ...state,
  };
}
