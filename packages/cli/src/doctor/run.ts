// agentx doctor (FR-050, FR-051): every check group in order. Each group runs even when an earlier
// one failed, so one run lists everything wrong.
import { agentXError } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { readInstallAnswers, readInstallProgress } from "../init/install-state.js";
import { plainMessage } from "../output.js";
import { alertChecks, capacityChecks, modelChecks, signInChecks } from "./account.js";
import { check, doctorReport, guarded, type DoctorCheck, type DoctorContext, type DoctorGroup, type DoctorReport, type DoctorServices } from "./checks.js";
import { connectorChecks } from "./connectors.js";
import { githubChecks } from "./github.js";
import { secretChecks } from "./secrets.js";
import { slackChecks } from "./slack.js";
import { stackChecks } from "./stacks.js";

const GROUPS: ReadonlyArray<[DoctorGroup, (context: DoctorContext) => Promise<DoctorCheck[]>]> = [
  ["stacks", stackChecks], ["secrets", secretChecks], ["slack", slackChecks], ["github", githubChecks], ["connectors", connectorChecks],
  ["models", modelChecks], ["alerts", alertChecks], ["capacity", capacityChecks], ["sign-in", signInChecks],
];

export async function runDoctor(input: { env: string; store: ParameterStore; services: (settings: EnvironmentSettings) => DoctorServices }): Promise<DoctorReport> {
  const { env, store } = input;
  const settings = await readEnvironmentSettings(store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `agentx doctor checks environments installed with agentx init; ${env} uses the legacy stack names`);
  const notes: DoctorCheck[] = [];
  const answers = await readInstallAnswers(store, env).catch((error: unknown) => { notes.push(check("stacks", "install answers", "warn", plainMessage(error))); return undefined; });
  const progress = await readInstallProgress(store, env).catch((error: unknown) => { notes.push(check("stacks", "install progress", "warn", plainMessage(error))); return undefined; });
  let services: DoctorServices;
  try {
    services = input.services(settings);
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `could not set up doctor's AWS, Slack and GitHub clients (${plainMessage(error)}); sign in to AWS for this account and region, then run agentx doctor again`);
  }
  const context: DoctorContext = { env, settings, answers, progress, services };
  const checks = [...notes];
  for (const [group, run] of GROUPS) checks.push(...await guarded(group, () => run(context)));
  return doctorReport(settings, checks);
}
