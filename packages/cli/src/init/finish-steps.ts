// The init steps after developer sign-in (phase 15d2), and the message init ends with. Each step
// is a thin wrapper around a setup/ module, so agentx init and the day-2 commands behave the same.
import { agentXError } from "@agentx/contracts";
import { AlertEmailSchema } from "../deploy/answer-schemas.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { tokenClaimValues, userPoolId } from "../setup/admin-session.js";
import { ensureCognitoAdmin } from "../setup/admin-user.js";
import { alertsTopicArn, ensureSubscribed, sendTestAlarm, type AlertTarget } from "../setup/alerts.js";
import { addChannel } from "../setup/channel-add.js";
import { addAsana } from "../setup/connectors/asana.js";
import { addJira } from "../setup/connectors/jira.js";
import { addLinear } from "../setup/connectors/linear.js";
import { addProject } from "../setup/project-add.js";
import { installationToken } from "../setup/project-files.js";
import { REPLY_WAIT_MS, waitForThreadedReply } from "../setup/reply-watch.js";
import { BUDGET_TAG_NOTE, checkAlertWebhook } from "./answers.js";
import { cliCommandLine, type CliInvocation } from "./cli-command.js";
import type { InitContext } from "./context.js";
import { CONNECTOR_LABELS, CONNECTOR_TYPES, type ConnectorType, type InstallProgress } from "./install-state.js";
import { problemText, retryOnPage } from "./retry.js";
import { botNameOf, readSlackBotToken } from "./slack-app.js";
import type { InitStep } from "./steps.js";
import { adminCard, alertsCard, channelCard, connectorsCard, projectCard, replyCard, type AdminCardInput, type ReplyCardInput } from "./ui/cards.js";
import { STEP_PLAN } from "./ui/journey.js";

/** The environment's settings, which the Slack service step writes; every finishing step and the
 * admin session need them (F21: one message, used by both). */
export async function readSettingsOrThrow(store: ParameterStore, env: string): Promise<EnvironmentSettings> {
  const settings = await readEnvironmentSettings(store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} has no settings yet; the Slack service step must finish first, so run agentx --env ${env} init again`);
  return settings;
}

export function requireSettings(context: InitContext): Promise<EnvironmentSettings> {
  return readSettingsOrThrow(context.store, context.env);
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
    title: STEP_PLAN["admin-user"].title,
    async run(context, progress) {
      const settings = await requireSettings(context);
      const recorded = progress.current().admin;
      const show = (card: AdminCardInput) => {
        // A failed sign-in's address is stale: the page drops its button, and a retry offers its own.
        if (card.stage === "failed") context.surface?.clearLink?.();
        context.surface?.card(adminCard(card));
      };
      // FR-050 (Q7): on the page, a sign-in that fails or times out can be tried again; the
      // terminal stops, as before. The sign-in page itself is the page's Next button (Q5).
      const signIn = (who: string, createdEmail?: string) => retryOnPage({
        surface: context.surface, prompter: context.prompter, question: "Sign in again?",
        failed: (problem) => show({ stage: "failed", problem }),
        run: async () => {
          show({ stage: "signing-in", who, ...(createdEmail === undefined ? {} : { createdEmail }) });
          return context.adminSession();
        },
      });
      if (settings.identity.mode === "cognito") {
        const email = recorded?.username ?? context.flags.adminEmail ?? await context.prompter.ask("Your email address, for your AgentX admin user", {
          flag: "--admin-email", validate: (value) => (AlertEmailSchema.safeParse(value).success ? undefined : "must be an email address"),
        });
        let created = false;
        if (recorded === undefined) {
          created = (await ensureCognitoAdmin({
            cognito: context.setup.cognito, poolId: userPoolId(settings), email, write: context.write,
            confirm: (question) => context.prompter.confirm(question, { defaultValue: false }),
          })).created;
          await progress.update({ admin: { username: email, mode: "cognito" } });
        }
        await signIn(email, created ? email : undefined);
        show({ stage: "done", username: email });
        return { status: "done", note: `admin ${email}` };
      }
      // F13 and C6 (FR-021): with your own OIDC, the admin claim is what makes someone an AgentX
      // administrator, so an install whose answers name none is refused, never signed in unchecked.
      const identity = context.answers.identity;
      if (identity.mode !== "oidc") {
        throw agentXError("CONFIG_INVALID", `the install's identity settings do not match its answers: /agentx/${context.env}/settings says your own OIDC provider, but the answers say Cognito; check which install wrote /agentx/${context.env}/settings, or start a new install with another --env`);
      }
      if (identity.adminClaim === undefined || identity.adminValues === undefined) {
        throw agentXError("CONFIG_INVALID", `the install's answers name no admin claim; AgentX cannot check that you are an administrator of your own OIDC provider, and an install's answers cannot change halfway. Start a new install with another --env, passing --admin-claim and --admin-values`);
      }
      const session = await signIn("an administrator of your company's sign-in");
      let username: string;
      try {
        username = oidcAdminName(session.accessToken);
      } catch (error) {
        // Signing in again would bring the same token back, so the page offers no retry here.
        show({ stage: "failed", problem: problemText(error), retry: false });
        throw error;
      }
      await progress.update({ admin: { username, mode: "oidc" } });
      show({ stage: "done", username });
      return { status: "done", note: `admin ${username} signed in with your OIDC provider` };
    },
  };
}

/** FR-040 and FR-041: the first project, on EC2 workers, and its Slack channel. */
export function firstProjectStep(): InitStep<InitContext> {
  return {
    id: "first-project",
    title: STEP_PLAN["first-project"].title,
    async run(context, progress) {
      const session = await context.adminSession();
      let project = progress.current().project;
      let shown = false;
      if (project === undefined) {
        const installationId = progress.current().github?.installationId;
        const githubToken = await installationToken({
          env: context.env, secrets: context.secrets, github: context.setup.github,
          ...(installationId === undefined ? {} : { installationId }),
          nowSeconds: Math.floor(context.now() / 1000),
        });
        let repository: string | undefined;
        const added = await addProject({
          env: context.env, session, githubToken, prompter: context.prompter, write: context.write, services: context.setup, flags: context.flags,
          onRepository: (fullName) => { repository = fullName; },
        });
        project = { name: added.name, revision: added.revision };
        await progress.update({ project });
        context.surface?.card(projectCard({ name: added.name, revision: added.revision, ...(repository === undefined ? {} : { repository }) }));
        shown = true;
      }
      // A project an earlier run recorded is shown without its repository, as is one added by an
      // unchanged rerun with --project-name, which chooses no repository.
      if (!shown) context.surface?.card(projectCard({ name: project.name, revision: project.revision }));
      if (project.channelId === undefined) {
        const slack = progress.current().slack;
        if (slack === undefined) throw agentXError("CONFIG_INVALID", "install progress has no Slack app facts; the Slack app step must finish first, so run agentx init again");
        let waitingFor: string | undefined;
        let bound: Awaited<ReturnType<typeof addChannel>>;
        try {
          bound = await addChannel({
            session, botToken: await readSlackBotToken(context.secrets, context.env), teamId: slack.teamId, botUserId: slack.botUserId, projectName: project.name,
            prompter: context.prompter, write: context.write, sleep: context.sleep, now: context.now, services: context.setup, flags: context.flags,
            onWaiting: (channelName) => {
              waitingFor = channelName;
              context.surface?.card(channelCard({ stage: "waiting", channelName, botName: botNameOf(progress.current(), context.answers.slack.appName) }));
            },
          });
        } catch (error) {
          // The invite wait is over: the page says so instead of still waiting.
          if (waitingFor !== undefined) context.surface?.card(channelCard({ stage: "failed", channelName: waitingFor, problem: problemText(error) }));
          throw error;
        }
        project = { ...project, channelId: bound.channelId, channelName: bound.channelName, teamId: slack.teamId };
        await progress.update({ project });
      }
      if (project.channelName !== undefined) context.surface?.card(channelCard({ stage: "done", channelName: project.channelName, projectName: project.name }));
      return { status: "done", note: `project ${project.name} in #${project.channelName ?? project.channelId}` };
    },
  };
}

// CONNECTOR_LABELS lives in install-state.ts so the page cards can read it without importing this
// module; re-exported so existing imports keep working.
export { CONNECTOR_LABELS };

const isConnectorType = (value: string): value is ConnectorType => (CONNECTOR_TYPES as readonly string[]).includes(value);

/** --connectors: a comma-separated list of linear, jira and asana, or none. Anything else (a typo,
 * or a connector AgentX does not have) is refused with the valid names, never dropped (F29). */
export function parseConnectorsFlag(value: string): Set<ConnectorType> {
  const names = value.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
  const wanted = new Set<ConnectorType>();
  for (const name of names) {
    if (name === "none") continue;
    if (!isConnectorType(name)) throw agentXError("CONFIG_INVALID", `--connectors ${name} is not a connector; use linear, jira, asana or none, separated by commas`);
    wanted.add(name);
  }
  if (names.includes("none") && wanted.size > 0) throw agentXError("CONFIG_INVALID", "--connectors none means no connectors; do not list it with linear, jira or asana");
  return wanted;
}

/** FR-036 to FR-039: offer each connector the install has not connected yet. */
export function connectorsStep(): InitStep<InitContext> {
  return {
    id: "connectors",
    title: STEP_PLAN.connectors.title,
    async run(context, progress) {
      const wanted = context.flags.connectors === undefined ? undefined : parseConnectorsFlag(context.flags.connectors);
      const project = progress.current().project;
      if (project === undefined) throw agentXError("CONFIG_INVALID", "install progress has no project; the first-project step must finish first, so run agentx init again");
      const done = new Set((progress.current().connectors ?? []).map((entry) => entry.type));
      for (const type of CONNECTOR_TYPES) {
        if (done.has(type)) continue;
        const yes = wanted !== undefined ? wanted.has(type) : await context.prompter.confirm(`Connect ${CONNECTOR_LABELS[type]} to ${project.name} now? (You can add it later with agentx connector add ${type})`, { defaultValue: false });
        if (!yes) continue;
        const session = await context.adminSession();
        // A connector that fails here is fixed by rerunning init, not the day-2 command.
        const base = { env: context.env, rerun: `agentx --env ${context.env} init`, session, projectName: project.name, secrets: context.secrets, prompter: context.prompter, processEnv: context.processEnv, write: context.write, services: context.setup, flags: context.flags };
        const result: { ref: string; revision: number; warning?: string } = type === "linear" ? await addLinear(base) : type === "jira" ? await addJira(base) : await addAsana(base);
        // Owner decision 6: a Jira connector that sees more than its project is saved with a
        // warning, and the warning is kept in the install progress (for 15e's doctor).
        const { warning } = result;
        const current = progress.current();
        await progress.update({
          connectors: [...(current.connectors ?? []), { type, ref: result.ref, ...(warning === undefined ? {} : { warning }) }],
          project: { ...(current.project ?? project), revision: result.revision },
        });
      }
      const connected = (progress.current().connectors ?? []).map((entry) => CONNECTOR_LABELS[entry.type]);
      // --connectors none, which --yes without --connectors also means (main.ts).
      if (wanted?.size === 0 && connected.length === 0) context.write(`No connectors added; add them later with agentx --env ${context.env} connector add linear|jira|asana`);
      context.surface?.card(connectorsCard({
        projectName: project.name,
        connected: (progress.current().connectors ?? []).map((entry) => ({ label: CONNECTOR_LABELS[entry.type], ...(entry.warning === undefined ? {} : { warning: entry.warning }) })),
      }));
      return { status: "done", note: connected.length === 0 ? "no connectors" : `connected ${connected.join(", ")}` };
    },
  };
}

/** FR-045 to FR-047: show the budget, subscribe the alert address, and send a test alarm. */
export function alertsStep(): InitStep<InitContext> {
  return {
    id: "alerts",
    title: STEP_PLAN.alerts.title,
    async run(context, progress) {
      const { answers } = context;
      const settings = await requireSettings(context);
      if (answers.budget !== undefined) {
        const limit = await context.setup.alerts.budget(settings.account, `agentx-${context.env}-monthly`);
        if (limit === undefined) throw agentXError("CONFIG_INVALID", `the budget agentx-${context.env}-monthly does not exist; check the control-plane stack's BudgetMonthlyUsd parameter, then run agentx init again`);
        context.write(`Budget agentx-${context.env}-monthly: $${limit} a month.${answers.budget.scope === "tag" ? ` ${BUDGET_TAG_NOTE}` : ""}`);
      }
      // --no-alerts: nothing to subscribe and nothing to test.
      if (answers.alert.kind === "none") {
        context.surface?.card(alertsCard({ stage: "none" }));
        return { status: "done", note: "no alert address (agentx config set alerts.address, phase 15e)" };
      }
      const recorded = progress.current().alerts ?? { subscribed: false, tested: false };
      const shownAs = answers.alert.kind === "email" ? answers.alert.address : answers.alert.display;
      const topicArn = await alertsTopicArn({ stackOutputs: context.setup.stackOutputs, stackName: settings.stacks["control-plane"], next: "run agentx init again" });
      if (!recorded.subscribed) {
        const target: AlertTarget = answers.alert.kind === "email"
          ? { kind: "email", address: answers.alert.address }
          : { kind: "webhook", display: answers.alert.display, endpoint: await requireWebhook(context, answers.alert.secretName) };
        const surface = context.surface;
        // On the page, a card shows the run's own wait for the confirmation while it polls.
        const subscribe = () => ensureSubscribed({
          api: context.setup.alerts, topicArn, target, write: context.write, sleep: context.sleep, now: context.now,
          ...(surface === undefined ? {} : { onWaiting: () => surface.card(alertsCard({ stage: "waiting", shownAs })) }),
        });
        let state = await subscribe();
        // Q7: on the page, the operator confirms and checks again; ensureSubscribed never
        // subscribes an address twice. The terminal stops and says to run init again, as before.
        while (state === "pending" && surface !== undefined) {
          surface.card(alertsCard({ stage: "confirm", shownAs }));
          if (!(await context.prompter.confirm("Have you confirmed the subscription? Answer Yes to check again.", { defaultValue: true }))) break;
          state = await subscribe();
        }
        if (state === "pending") return { status: "waiting", message: `Confirm the alert subscription for ${shownAs} (the AWS Notifications email, or your webhook's SubscribeURL), then run agentx init --env ${context.env} --region ${answers.region} again.` };
        // Recorded before the test alarm, so a failed test is retried without subscribing again.
        await progress.update({ alerts: { subscribed: true, tested: false } });
      }
      context.surface?.card(alertsCard({ stage: "testing", shownAs }));
      try {
        await sendTestAlarm({ api: context.setup.alerts, topicArn, env: context.env, shownAs, prompter: context.prompter, write: context.write, sleep: context.sleep, now: context.now });
      } catch (error) {
        // No retry on the page for the test alarm: the card shows the terminal's own next step.
        context.surface?.card(alertsCard({ stage: "failed", problem: problemText(error) }));
        throw error;
      }
      await progress.update({ alerts: { subscribed: true, tested: true } });
      context.surface?.card(alertsCard({ stage: "done", shownAs }));
      return { status: "done", note: `alerts to ${shownAs}, test alarm received` };
    },
  };
}

/** The webhook address, from its secret: it is never in the answers, the progress or the output. */
async function requireWebhook(context: InitContext, name: string): Promise<string> {
  const value = await context.secrets.get(name);
  if (value === undefined) throw agentXError("CONFIG_INVALID", `secret ${name} is missing; run agentx init with --alert-webhook-file or --alert-webhook-env to store it again`);
  return checkAlertWebhook(value.trim());
}

/** FR-018 step 11 (owner decision 7): a person mentions the bot in the bound channel, and init
 * watches the turn records for AgentX's threaded reply. */
export function e2eStep(): InitStep<InitContext> {
  return {
    id: "e2e",
    title: STEP_PLAN.e2e.title,
    async run(context, progress) {
      const { project, slack } = progress.current();
      if (project?.channelId === undefined || project.channelName === undefined || slack === undefined) {
        throw agentXError("CONFIG_INVALID", "install progress has no bound channel; the first-project step must finish first, so run agentx init again");
      }
      const where = { channelName: project.channelName, channelId: project.channelId, teamId: slack.teamId };
      const show = (card: ReplyCardInput) => context.surface?.card(replyCard(card));
      const reported = new Set<string>();
      // FR-051 (Q7): on the page, the card says what to fix and the operator watches again; the
      // terminal stops with the same advice, as before.
      const reply = await retryOnPage({
        surface: context.surface, prompter: context.prompter, question: "Watch for the reply again?",
        failed: (problem) => show({ stage: "failed", ...where, problem }),
        run: async () => {
          show({ stage: "waiting", ...where, botName: botNameOf(progress.current(), context.answers.slack.appName), minutes: Math.round(REPLY_WAIT_MS / 60_000) });
          return waitForThreadedReply({
            env: context.env, session: await context.adminSession(), fetch: context.setup.fetch, teamId: slack.teamId, channelId: where.channelId,
            channelName: where.channelName, botUserId: slack.botUserId, rerun: `agentx --env ${context.env} init`, write: context.write, sleep: context.sleep, now: context.now,
            reported,
          });
        },
      });
      show({ stage: "done", channelName: project.channelName, seconds: reply.seconds });
      return { status: "done", note: `a mention in #${project.channelName} got a threaded reply in ${reply.seconds} seconds` };
    },
  };
}

/** admin-user, first-project, connectors, alerts, e2e, in that order. */
export function finishSteps(): InitStep<InitContext>[] {
  return [adminUserStep(), firstProjectStep(), connectorsStep(), alertsStep(), e2eStep()];
}

/** The message a finished agentx init ends with: where to talk to AgentX, how developers sign in,
 * and the day-2 commands. FR-058, FR-059 and #222: the bot is named by its handle, never a raw
 * Slack mention, and every command is built from the CLI's own invocation, so it works as shown. */
export function readyText(input: { env: string; controlPlaneUrl: string; progress: InstallProgress; botName: string; invocation: CliInvocation }): string {
  const { env, progress } = input;
  const cli = (args: string) => cliCommandLine(input.invocation, `--env ${env} ${args}`);
  const { project } = progress;
  const connectors = progress.connectors ?? [];
  const connected = connectors.map((entry) => CONNECTOR_LABELS[entry.type]);
  return [
    `AgentX environment ${env} is ready.`,
    ...(project?.channelName === undefined ? [] : [`  Talk to it: mention @${input.botName} in #${project.channelName} (project ${project.name}).`]),
    // Repeated here: the developer-signin step prints it only on the run that executes it, and a
    // resume (after the alert confirmation wait, say) finishes without that step.
    `  Developers sign in with: ${cliCommandLine(input.invocation, `login ${input.controlPlaneUrl}`)}`,
    ...(project === undefined ? [] : [`  ${connected.length === 0 ? "No connectors yet." : `Connected: ${connected.join(", ")}.`} Add ${connected.length === 0 ? "one" : "more"} with ${cli(`connector add linear|jira|asana --project ${project.name}`)}.`]),
    // Owner decision 6: a connector saved with a warning says so again at the end.
    ...connectors.flatMap((entry) => (entry.warning === undefined ? [] : [`  Warning (${CONNECTOR_LABELS[entry.type]}): ${entry.warning}.`])),
    `  More projects: ${cli("project add")}, then ${cli("channel add")}.`,
    `  Send a test alarm any time: ${cli("alerts test")}.`,
    // The plan points here for removing everything, on the terminal path (--no-ui, --yes) too.
    `  Remove it: ${cli("destroy")}. It deletes the coding machines' disks too.`,
  ].join("\n");
}
