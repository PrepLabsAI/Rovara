// agentx doctor's shared shapes (FR-050, FR-051): every check says what it found and, when something
// is wrong, how to fix it. A check never carries a secret value: checks read secrets only to judge
// their shape, and every message here is built from names and fixed words.
import type { ReleaseManifest } from "@agentx/contracts";
import type { StackDescription } from "../environments/adopt.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { GitHubApi } from "../init/github-app.js";
import type { InitSecrets } from "../init/context.js";
import type { InitAnswers, InstallProgress } from "../init/install-state.js";
import type { PrerequisiteChecks } from "../init/prerequisites.js";
import type { SlackApi } from "../init/slack-app.js";
import type { AlertsApi } from "../setup/alerts.js";
import type { SlackChannelApi } from "../setup/channel-add.js";
import type { VendorApi } from "../setup/connectors/vendors.js";
import { plainMessage } from "../output.js";
import type { SignInCheck } from "../signin/check.js";

/** Re-exported so every doctor check reads it from here (ruling F11: one copy, in output.ts). */
export { plainMessage };

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type DoctorGroup = "stacks" | "secrets" | "slack" | "github" | "connectors" | "models" | "alerts" | "capacity" | "sign-in";
export interface DoctorCheck { group: DoctorGroup; name: string; status: CheckStatus; detail: string; fix?: string }
/** One stack as doctor reads it: env adopt's StackDescription, drift included (ruling F9). */
export type DoctorStack = StackDescription;

export interface DoctorServices {
  secrets: Pick<InitSecrets, "get">;
  stacks: { describe(stackName: string): Promise<DoctorStack | undefined> };
  /** The release manifest for a version: the local release cache, else the published release.json;
   * undefined when neither can be read. */
  releaseManifest: (version: string) => Promise<ReleaseManifest | undefined>;
  checks: Pick<PrerequisiteChecks, "converse" | "openRouter" | "directProvider" | "ec2Quota" | "elasticIps">;
  slackApi: SlackApi;
  slackChannels: SlackChannelApi;
  github: GitHubApi;
  vendors: VendorApi;
  /** Read-only: doctor lists subscriptions and reads the budget, and can never subscribe or alarm. */
  alerts: Pick<AlertsApi, "subscriptions" | "budget">;
  fetch: typeof fetch;
  /** Where project files live (the global --config-dir). */
  configDir: string;
  /** Spec 025 FR-046: agentx signin check's checks, unchanged (R5). */
  signIn: (settings: EnvironmentSettings) => Promise<SignInCheck[]>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface DoctorContext { env: string; settings: EnvironmentSettings; answers: InitAnswers | undefined; progress: InstallProgress | undefined; services: DoctorServices }
export interface DoctorReport { env: string; region: string; version: string; engine: string; checks: DoctorCheck[]; failed: number; warned: number; passed: number }

export function check(group: DoctorGroup, name: string, status: CheckStatus, detail: string, fix?: string): DoctorCheck {
  return { group, name, status, detail, ...(fix === undefined ? {} : { fix }) };
}

/** What to do about a group that threw. The detail names the failing call; the fix points only at the
 * service that group talks to: Slack and GitHub over the network, the AWS-only groups at AWS, and the
 * groups that mix several (connectors, sign-in) at the problem named. */
const GUARDED_FIX: Record<DoctorGroup, string> = {
  stacks: "check this computer's network access and AWS credentials, then run agentx doctor again",
  secrets: "check this computer's network access and AWS credentials, then run agentx doctor again",
  models: "check this computer's network access and AWS credentials, then run agentx doctor again",
  alerts: "check this computer's network access and AWS credentials, then run agentx doctor again",
  capacity: "check this computer's network access and AWS credentials, then run agentx doctor again",
  slack: "check this computer's network access to slack.com, then run agentx doctor again",
  github: "check this computer's network access to github.com, then run agentx doctor again",
  connectors: "fix the problem named above, then run agentx doctor again",
  "sign-in": "fix the problem named above, then run agentx doctor again",
};

/** A group that throws becomes one failed check, so one broken dependency never hides the others. */
export async function guarded(group: DoctorGroup, run: () => Promise<DoctorCheck[]>): Promise<DoctorCheck[]> {
  try {
    return await run();
  } catch (error) {
    return [check(group, `${group} checks`, "fail", `could not run the ${group} checks: ${plainMessage(error)}`, GUARDED_FIX[group])];
  }
}

export function doctorReport(settings: EnvironmentSettings, checks: DoctorCheck[]): DoctorReport {
  const count = (status: CheckStatus) => checks.filter((entry) => entry.status === status).length;
  return { env: settings.env, region: settings.region, version: settings.version, engine: settings.engine, checks, failed: count("fail"), warned: count("warn"), passed: count("ok") };
}

const LABEL: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };

export function reportText(report: DoctorReport): string {
  const lines = [`agentx doctor: environment ${report.env} (release ${report.version}, ${report.engine} engine, ${report.region})`];
  for (const entry of report.checks) {
    lines.push(`${LABEL[entry.status]}  ${entry.group.padEnd(10)}  ${entry.name}: ${entry.detail}`);
    if (entry.fix !== undefined && entry.status !== "ok") lines.push(`      fix: ${entry.fix}`);
  }
  const skipped = report.checks.filter((entry) => entry.status === "skip").length;
  lines.push(`${report.failed} failed, ${report.warned} ${report.warned === 1 ? "warning" : "warnings"}, ${report.passed} passed, ${skipped} skipped`);
  return `${lines.join("\n")}\n`;
}
