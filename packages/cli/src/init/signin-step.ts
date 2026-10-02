// Spec 025 FR-044: the init step that runs after the Slack service step. R9 does not hold (F15):
// an environment installed before 25a never reaches this step, because agentx init refuses to
// resume across a release mismatch (a 25a release is a new one); it turns sign-in on with agentx
// signin enable instead. This step asks which developer sign-in methods to enable (Slack by
// default), collects the Slack app's client ID and secret or the company OIDC app, and applies the
// same change as agentx signin enable (F16: enableSlackSignIn and enableOidcSignIn are shared, not
// copied), under the lock the step runner already holds.
import { AgentXError, agentXError } from "@agentx/contracts";
import { readEnvironmentSettings } from "../environments/settings.js";
import { applySignInChange, errorReason } from "../signin/apply.js";
import { SIGNIN_FLAG_NAMES, enableOidcSignIn, enableSlackSignIn, type SignInCredentials } from "../signin/collect.js";
import { readSignInSettings, type DeveloperSignInSettings } from "../signin/settings.js";
import { cliCommandLine } from "./cli-command.js";
import type { InitContext } from "./context.js";
import type { SlackApi } from "./slack-app.js";
import type { InitStep } from "./steps.js";
import { STEP_PLAN } from "./ui/journey.js";

/** Combines the Slack and company credentials collected for --signin both into the one
 * `applySignInChange` accepts, so both are stored, only once, only after the single change is
 * confirmed (F21, carried from Task 12), and never half: a failed company write puts the Slack
 * secret back before the error goes on. */
export function combinedCredentials(slack: SignInCredentials | undefined, oidc: SignInCredentials | undefined): SignInCredentials | undefined {
  if (slack === undefined) return oidc;
  if (oidc === undefined) return slack;
  return {
    secretName: `${slack.secretName} and ${oidc.secretName}`,
    async store() {
      await slack.store();
      try {
        await oidc.store();
      } catch (error) {
        try {
          await slack.restore();
        } catch (restoreError) {
          throw agentXError(error instanceof AgentXError ? error.code : "RUNTIME_UNAVAILABLE", `${errorReason(error)}; putting the previous client credentials back in ${slack.secretName} failed too (${errorReason(restoreError)}), so Slack sign-in may fail until you run agentx init again`);
        }
        throw error;
      }
    },
    // Undoes both, in reverse order, trying each even when the other fails; each restore is a
    // no-op for a secret its store never wrote.
    async restore() {
      const done: string[] = [];
      const failed: string[] = [];
      for (const part of [oidc, slack]) {
        try { done.push(await part.restore()); } catch (error) { failed.push(`${part.secretName}: ${errorReason(error)}`); }
      }
      if (failed.length > 0) throw new Error([...done, `could not put back ${failed.join(", ")}`].join("; "));
      return done.join("; ");
    },
  };
}

export function developerSignInStep(input: { slack: SlackApi }): InitStep<InitContext> {
  return {
    id: "developer-signin",
    title: STEP_PLAN["developer-signin"].title,
    async run(context, progress) {
      const { env } = context;
      if ((await readSignInSettings(context.store, env)) !== undefined) return { status: "done", note: "developer sign-in was already set up" };
      const settings = await readEnvironmentSettings(context.store, env);
      if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} has no settings yet; the Slack service step must finish first, so run agentx init again`);
      const methods = context.signinFlags.methods ?? await context.prompter.choose<"slack" | "oidc" | "both">("How will developers sign in to AgentX from their AI tools?", [
        { value: "slack", label: "Sign in with Slack (recommended)" },
        { value: "oidc", label: "Your company's sign-in (OIDC)" },
        { value: "both", label: "Both" },
      ], { flag: SIGNIN_FLAG_NAMES.methods, defaultValue: "slack" });
      const questions = {
        env, apiEndpoint: settings.controlPlaneUrl, secrets: context.secrets, prompter: context.prompter,
        processEnv: context.processEnv, flags: context.signinFlags, secretFlags: context.secretFlags, write: context.write,
      };

      let slackTeamId: string | undefined;
      let slackCredentials: SignInCredentials | undefined;
      if (methods !== "oidc") {
        const expected = progress.current().slack?.teamId;
        const enabled = await enableSlackSignIn({ ...questions, slackApi: input.slack, ...(expected === undefined ? {} : { expectedTeamId: expected }) });
        slackTeamId = enabled.teamId;
        slackCredentials = enabled.credentials;
      }
      let oidc: NonNullable<DeveloperSignInSettings["oidc"]> | undefined;
      let oidcCredentials: SignInCredentials | undefined;
      if (methods !== "slack") {
        const enabled = await enableOidcSignIn({ ...questions, fetch: context.fetch });
        oidc = enabled.oidc;
        oidcCredentials = enabled.credentials;
      }
      const credentials = combinedCredentials(slackCredentials, oidcCredentials);
      await applySignInChange({
        env, store: context.store, cloudFormation: context.cloudFormation, holder: context.holder, settings,
        next: { slack: methods !== "oidc", ...(oidc === undefined ? {} : { oidc }) },
        ...(slackTeamId === undefined ? {} : { slackTeamId }),
        ...(credentials === undefined ? {} : { credentials }),
        confirm: async (text) => { context.write(text); return context.prompter.confirm("Apply this change?", { defaultValue: true }); },
        write: context.write, now: context.now, sleep: context.sleep, lockHeld: true, rerun: "agentx init",
      });
      context.write(`Developers sign in with: ${cliCommandLine(context.cliInvocation, `login ${settings.controlPlaneUrl}`)}`);
      return { status: "done", note: `developer sign-in: ${methods === "both" ? "Slack and company sign-in" : methods === "slack" ? "Slack" : "company sign-in"}` };
    },
  };
}
