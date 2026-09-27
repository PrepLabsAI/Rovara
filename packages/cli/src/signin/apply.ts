// Show the sign-in change, confirm it, update the control plane's parameters, then record the
// settings (spec 025 FR-045, R6, R7). Runs under the environment lock. Client secrets are written
// only once the change is confirmed (F21), and are never printed.
import { agentXError } from "@agentx/contracts";
import { updateStackParameters } from "../deploy/parameter-update.js";
import { withEnvironmentLock } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { SignInCredentials } from "./collect.js";
import { DeveloperSignInSettingsSchema, describeSignIn, readSignInSettings, readSlackTeamId, signInStackParameters, writeSignInSettings, writeSlackTeamId, type DeveloperSignInSettings } from "./settings.js";

export interface ApplySignInInput {
  env: string; store: ParameterStore; cloudFormation: { send(command: unknown): Promise<unknown> }; holder: string; settings: EnvironmentSettings;
  next: { slack: boolean; oidc?: NonNullable<DeveloperSignInSettings["oidc"]> }; slackTeamId?: string;
  /** Collected client credentials, stored only after the change is confirmed and before the stack changes. */
  credentials?: SignInCredentials;
  /** Shows `text` (the whole change) and answers whether to apply it; the question itself is the caller's. */
  confirm: (text: string) => Promise<boolean>; write: (line: string) => void; now: () => number; lockHeld?: boolean;
  sleep?: (ms: number) => Promise<void>; pollMs?: number;
}

/** "Slack sign-in: off" and "Slack sign-in: on" become "  Slack sign-in: off -> on"; an unchanged line is printed as it is. */
export function changeLine(before: string, after: string): string {
  if (before === after) return `  ${after}`;
  const [label, beforeState = ""] = before.split(": ");
  return `  ${label}: ${beforeState.split(" ")[0]} -> ${after.slice(after.indexOf(": ") + 2)}`;
}

const signedOut = (method: string) => `Everyone signed in with ${method} is signed out as soon as the update finishes: the control plane refuses their tokens and their refreshes.`;
const shown = (value: string) => (value === "" ? "(empty)" : value);
const notApplied = (stackName: string) => agentXError("CONFIG_INVALID", `the sign-in change to ${stackName} was not applied; nothing changed`);

export async function applySignInChange(input: ApplySignInInput): Promise<{ changed: boolean; settings: DeveloperSignInSettings }> {
  const roleArn = input.settings.access?.cloudFormationRoleArn;
  if (input.settings.naming !== "environment" || roleArn === undefined) {
    throw agentXError("CONFIG_INVALID", `developer sign-in needs an environment installed with agentx init; ${input.env} uses the legacy stack names`);
  }
  const stackName = input.settings.stacks["control-plane"];
  const work = async () => {
    const current = await readSignInSettings(input.store, input.env);
    const parsed = DeveloperSignInSettingsSchema.safeParse({
      schemaVersion: 1, env: input.env, slack: input.next.slack, ...(input.next.oidc === undefined ? {} : { oidc: input.next.oidc }),
      updatedAt: new Date(input.now()).toISOString(), updatedBy: input.holder,
    });
    if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.message ?? "developer sign-in settings are invalid"}; check the answers and run this again`);
    const next = parsed.data;
    const teamId = input.slackTeamId ?? await readSlackTeamId(input.store, input.env);
    if (next.slack && teamId === undefined) throw agentXError("CONFIG_INVALID", "Slack sign-in needs the Slack team ID; run agentx signin enable slack, which records it");
    const before = describeSignIn(current);
    const after = describeSignIn(next);
    const summary = [
      `Developer sign-in for ${input.env}:`,
      ...before.map((line, index) => changeLine(line, after[index] ?? line)),
      ...(current?.slack === true && !next.slack ? [signedOut("Slack")] : []),
      ...(current?.oidc !== undefined && next.oidc === undefined ? [signedOut("company sign-in")] : []),
    ];
    const credentialsLine = input.credentials === undefined ? [] : [`The client credentials will be stored in ${input.credentials.secretName}.`];

    let asked = false;
    let storeFailure: Error | undefined;
    let changed: boolean;
    try {
      ({ changed } = await updateStackParameters({
        cloudFormation: input.cloudFormation,
        stackName,
        roleArn,
        changes: signInStackParameters({ settings: next, ...(teamId === undefined ? {} : { slackTeamId: teamId }) }),
        write: input.write,
        ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
        ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
        confirm: async ({ parameters, changes }) => {
          asked = true;
          const confirmed = await input.confirm([
            ...summary,
            ...parameters.map((parameter) => `  ${parameter.name}: ${shown(parameter.from)} -> ${shown(parameter.to)}`),
            `${stackName} will change: ${changes.map((change) => `${change.action} ${change.logicalId} (${change.type})`).join(", ") || "parameters only"}`,
            ...credentialsLine,
          ].join("\n"));
          if (!confirmed || input.credentials === undefined) return confirmed;
          // Stored before the stack changes, so the control plane finds them once sign-in is on. A
          // failed write declines the change set (which deletes it), and its error is rethrown below.
          try {
            await input.credentials.store();
          } catch (error) {
            storeFailure = error instanceof Error ? error : agentXError("RUNTIME_UNAVAILABLE", `could not store the client credentials in ${input.credentials.secretName}; nothing changed, so run this again`);
            return false;
          }
          return true;
        },
      }));
    } catch (error) {
      if (storeFailure !== undefined) throw storeFailure;
      throw error;
    }
    if (!asked && input.credentials !== undefined) {
      // The stack already matches (new credentials for a method that is on): ask before replacing them.
      const confirmed = await input.confirm([...summary, `${stackName} does not change; the new client credentials replace the stored ones in ${input.credentials.secretName}.`].join("\n"));
      if (!confirmed) throw notApplied(stackName);
      await input.credentials.store();
      changed = true;
    }
    await writeSignInSettings(input.store, next);
    if (input.slackTeamId !== undefined) await writeSlackTeamId(input.store, input.env, input.slackTeamId);
    return { changed, settings: next };
  };
  return input.lockHeld === true ? work() : withEnvironmentLock({ store: input.store, env: input.env, holder: input.holder, command: "signin", now: input.now }, work);
}
