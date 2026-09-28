// Show the sign-in change, confirm it, update the control plane's parameters, then record the
// settings (spec 025 FR-045, R6, R7). Runs under the environment lock. Client secrets are written
// only once the change is confirmed (F21), and are never printed.
import { DescribeStacksCommand, ExecuteChangeSetCommand, type Stack } from "@aws-sdk/client-cloudformation";
import { AgentXError, agentXError } from "@agentx/contracts";
import { updateStackParameters } from "../deploy/parameter-update.js";
import { withEnvironmentLock } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { SignInCredentials } from "./collect.js";
import { DeveloperSignInSettingsSchema, describeSignIn, readSignInSettings, readSlackTeamId, signInParameterName, signInStackParameters, writeSignInSettings, writeSlackTeamId, type DeveloperSignInSettings } from "./settings.js";

export interface SignInChoice { slack: boolean; oidc?: NonNullable<DeveloperSignInSettings["oidc"]> }

export interface ApplySignInInput {
  env: string; store: ParameterStore; cloudFormation: { send(command: unknown): Promise<unknown> }; holder: string; settings: EnvironmentSettings;
  /** The methods to enable; a function builds them from the settings read under the lock, so a concurrent change is not lost. */
  next: SignInChoice | ((current: DeveloperSignInSettings | undefined) => SignInChoice); slackTeamId?: string;
  /** The command that finishes a half-done change, named in errors; the same agentx signin command by default. */
  rerun?: string;
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
/** An error's own words, without AgentXError's "CODE: " prefix (a rewrapped error gets its code back). */
export const errorReason = (error: unknown) => (error instanceof AgentXError ? error.message.slice(error.code.length + 2) : error instanceof Error ? error.message : "no reason given");
/** Keeps an AgentXError's code, so the exit-code mapping is unchanged. */
const withMessage = (error: unknown, message: string) => (error instanceof AgentXError ? agentXError(error.code, message) : agentXError("RUNTIME_UNAVAILABLE", message));
/** The settled statuses in which the stack did not take the change, so the old credentials go back. */
const RESTORE_ON = new Set(["UPDATE_ROLLBACK_COMPLETE", "UPDATE_FAILED"]);

type StackOutcome =
  | { kind: "unreadable"; problem: string }
  | { kind: "running"; status: string }
  | { kind: "applied" | "failed" | "other"; status: string };

/**
 * Where a failed update left the stack. "failed" (restore) only for an allow-listed status, or
 * when the change set never executed (the stack is untouched). Otherwise the new credentials are
 * kept: "unreadable" (DescribeStacks failed), "running" (in progress), "applied" (settled with every
 * changed parameter), or "other" (settled some other way, such as UPDATE_ROLLBACK_FAILED).
 */
async function stackOutcome(cloudFormation: ApplySignInInput["cloudFormation"], stackName: string, changes: Record<string, string>, executed: boolean): Promise<StackOutcome> {
  let stack: Stack | undefined;
  try {
    stack = ((await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))) as { Stacks?: Stack[] }).Stacks?.[0];
  } catch (error) {
    return { kind: "unreadable", problem: errorReason(error) };
  }
  const status = stack?.StackStatus ?? "";
  if (stack === undefined || status === "") return { kind: "unreadable", problem: "no status was returned" };
  if (status.endsWith("_IN_PROGRESS")) return { kind: "running", status };
  if (RESTORE_ON.has(status) || !executed) return { kind: "failed", status };
  const current = new Map((stack.Parameters ?? []).map((parameter) => [parameter.ParameterKey ?? "", parameter.ParameterValue ?? ""]));
  return { kind: Object.entries(changes).every(([name, value]) => current.get(name) === value) ? "applied" : "other", status };
}

const notApplied = (stackName: string) => agentXError("CONFIG_INVALID", `the sign-in change to ${stackName} was not applied; nothing changed`);

export async function applySignInChange(input: ApplySignInInput): Promise<{ changed: boolean; settings: DeveloperSignInSettings }> {
  const roleArn = input.settings.access?.cloudFormationRoleArn;
  if (input.settings.naming !== "environment" || roleArn === undefined) {
    throw agentXError("CONFIG_INVALID", `developer sign-in needs an environment installed with agentx init; ${input.env} uses the legacy stack names`);
  }
  const stackName = input.settings.stacks["control-plane"];
  const rerun = input.rerun ?? "the same agentx signin command";
  const work = async () => {
    const current = await readSignInSettings(input.store, input.env);
    const choice = typeof input.next === "function" ? input.next(current) : input.next;
    // FR-045: a method going from off to on gets a new cutoff, so the sessions its disable ended
    // (a laptop asleep through the disable never refreshed) stay ended. Otherwise it is kept.
    const nowSeconds = Math.floor(input.now() / 1000);
    const since = {
      ...current?.since,
      ...(choice.slack && current?.slack !== true ? { slack: nowSeconds } : {}),
      ...(choice.oidc !== undefined && current?.oidc === undefined ? { oidc: nowSeconds } : {}),
    };
    const parsed = DeveloperSignInSettingsSchema.safeParse({
      schemaVersion: 1, env: input.env, slack: choice.slack, ...(choice.oidc === undefined ? {} : { oidc: choice.oidc }),
      ...(Object.keys(since).length === 0 ? {} : { since }),
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
    let stored = false;
    let storeFailure: Error | undefined;
    let changed: boolean;
    let stackChanged = false;
    let executed = false;
    // Records whether ExecuteChangeSet was accepted, so a failure before it counts as "never executed".
    const cloudFormation = {
      send: async (command: unknown) => {
        const result = await input.cloudFormation.send(command);
        if (command instanceof ExecuteChangeSetCommand) executed = true;
        return result;
      },
    };
    const parameterChanges = signInStackParameters({ settings: next, ...(teamId === undefined ? {} : { slackTeamId: teamId }) });
    try {
      ({ changed } = await updateStackParameters({
        cloudFormation,
        stackName,
        roleArn,
        changes: parameterChanges,
        write: input.write,
        now: input.now,
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
            stored = true;
          } catch (error) {
            storeFailure = error instanceof Error ? error : agentXError("RUNTIME_UNAVAILABLE", `could not store the client credentials in ${input.credentials.secretName}; nothing changed, so run this again`);
            return false;
          }
          return true;
        },
      }));
    } catch (error) {
      if (storeFailure !== undefined) throw storeFailure;
      if (!stored || input.credentials === undefined) throw error;
      const { secretName } = input.credentials;
      // Restore only once the stack has settled without the change (UPDATE_ROLLBACK_COMPLETE,
      // UPDATE_FAILED, or a change set that never executed). While it may still be updating (a
      // timeout, or a status that cannot be read), restoring could leave the new parameters on top
      // of the old secret, and sign-in would break unnoticed: keep the new credentials instead.
      const outcome = await stackOutcome(input.cloudFormation, stackName, parameterChanges, executed);
      // Never "sign-in did not change" while the new credentials are kept.
      const said = errorReason(error).replace("; sign-in did not change", "");
      const checkThenRerun = `check the stack's status in the CloudFormation console, then run ${rerun} again`;
      if (outcome.kind === "unreadable") {
        throw withMessage(error, `${said}; the state of ${stackName} could not be confirmed (${outcome.problem}); the new client credentials are kept in ${secretName}; ${checkThenRerun}`);
      }
      if (outcome.kind === "running") {
        throw withMessage(error, `the update of ${stackName} is still running (${said}); the new client credentials are kept in ${secretName}; ${checkThenRerun}`);
      }
      if (outcome.kind === "applied") {
        throw withMessage(error, `${said}; ${stackName} did take the change, so the new client credentials are kept in ${secretName}; run ${rerun} again to record the settings`);
      }
      if (outcome.kind === "other") {
        throw withMessage(error, `${said}; ${stackName} is ${outcome.status}, so the new client credentials are kept in ${secretName}; check the stack in the CloudFormation console, then run ${rerun} again`);
      }
      let restored: string;
      try {
        restored = await input.credentials.restore();
      } catch (restoreError) {
        throw withMessage(error, `${errorReason(error).replace("; sign-in did not change", "")}; putting the previous client credentials back in ${secretName} failed too (${errorReason(restoreError)}), so sign-in may fail until you run ${rerun} again`);
      }
      throw withMessage(error, `${errorReason(error)}; ${restored}`);
    }
    if (!asked && input.credentials !== undefined) {
      // The stack already matches (new credentials for a method that is on): ask before replacing them.
      const confirmed = await input.confirm([...summary, `${stackName} does not change; the new client credentials replace the stored ones in ${input.credentials.secretName}.`].join("\n"));
      if (!confirmed) throw notApplied(stackName);
      await input.credentials.store();
      // The control plane caches the secret for 5 minutes (developer-identity.ts SECRET_CACHE_MS);
      // no stack change restarts it here, so the old credentials may be used until then.
      input.write("The new client credentials take effect within 5 minutes, once the control plane's cached copy expires.");
      changed = true;
    } else {
      stackChanged = changed;
    }
    try {
      await writeSignInSettings(input.store, next);
      if (input.slackTeamId !== undefined) await writeSlackTeamId(input.store, input.env, input.slackTeamId);
    } catch (error) {
      const what = stackChanged ? `${stackName} was updated`
        : changed && input.credentials !== undefined ? `the client credentials in ${input.credentials.secretName} were replaced (${stackName} already matched)`
          : `${stackName} already matched`;
      throw withMessage(error, `${what}, but recording the sign-in settings at ${signInParameterName(input.env)} failed (${errorReason(error)}); run ${rerun} again to record them`);
    }
    return { changed, settings: next };
  };
  return input.lockHeld === true ? work() : withEnvironmentLock({ store: input.store, env: input.env, holder: input.holder, command: "signin", now: input.now }, work);
}
