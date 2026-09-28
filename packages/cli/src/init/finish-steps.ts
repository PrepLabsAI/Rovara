// The init steps after developer sign-in (phase 15d2): each is a thin wrapper around a setup/
// module, so agentx init and the day-2 commands behave the same.
import { agentXError } from "@agentx/contracts";
import { AlertEmailSchema } from "../deploy/answer-schemas.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { tokenClaimValues, userPoolId } from "../setup/admin-session.js";
import { ensureCognitoAdmin } from "../setup/admin-user.js";
import { addProject } from "../setup/project-add.js";
import { installationToken } from "../setup/project-files.js";
import type { InitContext } from "./context.js";
import type { InitStep } from "./steps.js";

export async function requireSettings(context: InitContext): Promise<EnvironmentSettings> {
  const settings = await readEnvironmentSettings(context.store, context.env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${context.env} has no settings yet; the Slack service step must finish first, so run agentx init again`);
  return settings;
}

/** Who signed in with your own OIDC provider, from the token's email claim or else its sub (F24). */
function oidcAdminName(accessToken: string): string {
  const name = [...tokenClaimValues(accessToken, "email"), ...tokenClaimValues(accessToken, "sub")]
    .find((value) => value.length >= 3 && value.length <= 128);
  if (name === undefined) {
    throw agentXError("CONFIG_INVALID", "your sign-in token has no email or sub claim of 3 to 128 characters to record the admin by; make your identity provider put one in the access token, then run agentx init again");
  }
  return name;
}

export function adminUserStep(): InitStep<InitContext> {
  return {
    id: "admin-user",
    title: "Create the admin user and sign in",
    async run(context, progress) {
      const settings = await requireSettings(context);
      const recorded = progress.current().admin;
      if (settings.identity.mode === "cognito") {
        const email = recorded?.username ?? context.flags.adminEmail ?? await context.prompter.ask("Your email address, for your AgentX admin user", {
          flag: "--admin-email", validate: (value) => (AlertEmailSchema.safeParse(value).success ? undefined : "must be an email address"),
        });
        if (recorded === undefined) {
          await ensureCognitoAdmin({
            cognito: context.setup.cognito, poolId: userPoolId(settings), email, write: context.write,
            confirm: (question) => context.prompter.confirm(question, { defaultValue: false }),
          });
          await progress.update({ admin: { username: email, mode: "cognito" } });
        }
        await context.adminSession();
        return { status: "done", note: `admin ${email}` };
      }
      const session = await context.adminSession();
      const username = oidcAdminName(session.accessToken);
      await progress.update({ admin: { username, mode: "oidc" } });
      return { status: "done", note: `admin ${username} signed in with your OIDC provider` };
    },
  };
}

/** FR-040: the first project, on EC2 workers. Task 8 adds its channel. */
export function firstProjectStep(): InitStep<InitContext> {
  return {
    id: "first-project",
    title: "Set up the first project and its channel",
    async run(context, progress) {
      const session = await context.adminSession();
      let project = progress.current().project;
      if (project === undefined) {
        const installationId = progress.current().github?.installationId;
        const githubToken = await installationToken({
          env: context.env, secrets: context.secrets, github: context.setup.github,
          ...(installationId === undefined ? {} : { installationId }),
          nowSeconds: Math.floor(context.now() / 1000),
        });
        const added = await addProject({ env: context.env, session, githubToken, prompter: context.prompter, write: context.write, services: context.setup, flags: context.flags });
        project = { name: added.name, revision: added.revision };
        await progress.update({ project });
      }
      // Task 8 binds the channel here.
      return { status: "done", note: `project ${project.name}` };
    },
  };
}
