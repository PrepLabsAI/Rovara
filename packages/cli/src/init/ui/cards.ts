// packages/cli/src/init/ui/cards.ts
// What each screen of the install page says (spec 040 FR-020 to FR-041, and phase 3's finishing
// screens; spec 048 FR-027, FR-037, FR-080: plain words, names instead of IDs, and raw technical
// detail collapsed rather than dropped). Every card is built here, from facts a step already has,
// so the page's words are tested in one place and the page only lays text out. No builder takes a
// secret, so no card can carry one (FR-012).
import { cliCommandLine, type CliInvocation } from "../cli-command.js";
import { CONNECTOR_LABELS, type InstallProgress } from "../install-state.js";
import { ADMIN_USER_GUIDE_URL, DEDICATED_ACCOUNT_NOTE, ROOT_WARNING, type PrerequisiteCheck } from "../prerequisites.js";
import type { WizardCard } from "./protocol.js";

/** A button's label for an address the run opens: "Open github.com". */
export function linkLabel(url: string): string {
  try {
    return `Open ${new URL(url).host}`;
  } catch {
    return "Open the address";
  }
}

/** A step's error as a card shows it where the page offers to try again in place: without the
 * terminal's closing "run agentx init again" (or "run agentx --env <env> init again"), which would
 * send the operator the wrong way. The terminal's error text is unchanged. */
export function onPageProblem(problem: string): string {
  return problem.replace(/[;,] (?:then )?run agentx (?:--env \S+ )?init again\.?$/, "");
}

/** FR-027: who is signed in, in words. The ARN itself goes to the card's details. */
export function signedInAs(arn: string): string {
  if (/:root$/.test(arn)) return "the AWS root user";
  const sso = /:assumed-role\/AWSReservedSSO_(.+)_[0-9a-f]{16}\/(.+)$/.exec(arn);
  if (sso !== null) return `${sso[2] ?? "you"} (${sso[1] ?? "a permission set"}, through IAM Identity Center)`;
  const role = /:assumed-role\/([^/]+)\/(.+)$/.exec(arn);
  if (role !== null) return `${role[2] ?? "you"} (role ${role[1] ?? ""})`;
  const user = /:user\/(?:.*\/)?([^/]+)$/.exec(arn);
  if (user !== null) return `the IAM user ${user[1] ?? ""}`;
  return "your AWS sign-in";
}

export function awsCard(input: { account: string; arn: string; region: string; profile?: string }): WizardCard {
  return {
    id: "aws", title: "AWS account", status: "ok",
    lines: [
      `AgentX installs into AWS account ${input.account} in ${input.region}.`,
      `You are signed in as ${signedInAs(input.arn)}${input.profile === undefined ? "" : `, with the AWS profile ${input.profile}`}.`,
      DEDICATED_ACCOUNT_NOTE,
    ],
    details: [input.arn],
  };
}

/** FR-016: the caller is the AWS root user. The page still offers to continue. */
export function rootUserCard(input: { account: string; arn: string; region: string; profile?: string }): WizardCard {
  return {
    id: "aws", title: "AWS account", status: "waiting",
    lines: [
      `AgentX installs into AWS account ${input.account} in ${input.region}.`,
      ROOT_WARNING,
      "You can continue as root. A few day-two commands need an admin user instead; the ready screen says which.",
    ],
    link: { url: ADMIN_USER_GUIDE_URL, label: "How to create an admin user" },
    details: [input.arn],
  };
}

/** FR-021: the session is missing or expired. `signIn` is the command Sign in runs, when the
 * profile has one; `ranProblem` is why the last sign-in could not run. */
export function awsSignedOutCard(input: { profile?: string; problem: string; signIn?: string; ranProblem?: string }): WizardCard {
  return {
    id: "aws", title: "AWS account", status: "failed",
    lines: [
      input.profile === undefined ? "Your AWS sign-in is missing or has ended." : `The AWS sign-in of the profile ${input.profile} is missing or has ended.`,
      input.signIn !== undefined
        ? "Choose Sign in again. A browser tab opens for the AWS sign-in; finish it there, then come back to this tab."
        : "Sign in to AWS again another way, then choose I signed in another way, check again.",
    ],
    details: [input.problem, ...(input.signIn === undefined ? [] : [`Sign-in command: ${input.signIn}`]), ...(input.ranProblem === undefined ? [] : [input.ranProblem])],
  };
}

/** The prerequisites as a checklist (FR-023): each check with its own result, as it finishes. */
export function prerequisitesCard(input: { status: "running" | "ok" | "failed"; checks: readonly PrerequisiteCheck[] }): WizardCard {
  const lines = input.status === "running"
    ? ["Checking your account and region. Nothing is created yet."]
    : input.status === "ok"
      ? ["Everything AgentX needs is in place."]
      : ["Nothing has been created. Fix each item marked Not ready, then choose Check again."];
  const technical = input.checks.flatMap((check) => (check.technical === undefined ? [] : [`${check.label}: ${check.technical}`]));
  return {
    id: "prerequisites", title: "Check your AWS account", status: input.status, lines,
    checks: input.checks.map((check) => ({ label: check.label, ok: check.ok, detail: check.detail })),
    ...(technical.length === 0 ? {} : { details: technical }),
  };
}

export type GitHubCardInput =
  | { stage: "create"; appName: string; account: string; startUrl: string }
  | { stage: "install"; appName: string; slug: string; account: string; installUrl: string }
  | { stage: "repositories"; appName: string; slug: string; account: string; settingsUrl: string }
  | { stage: "done"; appName: string; slug: string; account: string }
  /** A wait or check that failed. The page offers no retry, so the problem keeps its own next step. */
  | { stage: "failed"; problem: string };

/** FR-030 and FR-031: creating the app, then the installation wait, as one card. */
export function githubCard(input: GitHubCardInput): WizardCard {
  const base = { id: "github" as const, title: "GitHub app" };
  const slug = (value: string) => ({ details: [`GitHub app slug: ${value}`] });
  switch (input.stage) {
    case "create": return {
      ...base, status: "waiting",
      lines: [`Create the GitHub app "${input.appName}" for ${input.account}.`, "GitHub opens with everything filled in. Press Create GitHub App there.", "This page moves on by itself when GitHub sends you back."],
      link: { url: input.startUrl, label: "Open GitHub" },
    };
    case "install": return {
      ...base, status: "waiting", ...slug(input.slug),
      lines: [`Install "${input.appName}" on ${input.account}. Choose only the repositories AgentX should work on.`, "This page moves on by itself when the app is installed."],
      link: { url: input.installUrl, label: "Choose repositories" },
    };
    case "repositories": return {
      ...base, status: "waiting", ...slug(input.slug),
      lines: [`"${input.appName}" is installed, but it can see no repositories.`, "Choose at least one. This page moves on by itself."],
      link: { url: input.settingsUrl, label: "Choose repositories" },
    };
    case "done": return { ...base, status: "ok", ...slug(input.slug), lines: [`"${input.appName}" is installed on ${input.account}.`] };
    case "failed": return { ...base, status: "failed", lines: ["The GitHub app was not set up."], details: [input.problem] };
  }
}

export type SlackCardInput =
  | { stage: "create"; appName: string; createUrl: string }
  | { stage: "credentials"; appName: string }
  | { stage: "bot"; user: string; team: string }
  /** `retry: false` when the page cannot offer a paste again: the problem is shown whole, with its
   * advice to run agentx init again, kept in the details. */
  | { stage: "refused"; problem: string; retry?: false }
  | { stage: "approval"; appName: string }
  | { stage: "done"; appName: string; appId: string; teamId: string; teamName?: string };

export const SLACK_APPS_URL = "https://api.slack.com/apps";

/** FR-040: the Slack app, from the create button to its stored credentials. */
export function slackAppCard(input: SlackCardInput): WizardCard {
  const base = { id: "slack" as const, title: "Slack app" };
  switch (input.stage) {
    case "create": return {
      ...base, status: "waiting",
      lines: [
        `Create the Slack app "${input.appName}". Slack opens with everything filled in.`,
        "Pick your workspace, press Next, then Create, then Install to Workspace.",
        "Slack may show a red error next to the Request URL. That is expected; AgentX fixes it in a later step.",
        "If your workspace needs an admin to approve new apps, choose Request to Install there, then choose My workspace needs an admin to approve it below.",
      ],
      link: { url: input.createUrl, label: "Open Slack" },
    };
    case "credentials": return {
      ...base, status: "waiting",
      lines: [
        `Copy two values from the settings of "${input.appName}" and paste them below.`,
        "The Bot User OAuth Token is under OAuth & Permissions. The Signing Secret is under Basic Information, App Credentials.",
        "Both are saved in AWS Secrets Manager and never shown again.",
      ],
      link: { url: SLACK_APPS_URL, label: "Open your Slack apps" },
    };
    case "bot": return { ...base, status: "waiting", lines: [`The token belongs to the bot @${input.user} in the ${input.team} workspace.`] };
    case "refused": return {
      ...base, status: "failed",
      lines: [input.retry === false ? "Slack did not accept those values." : onPageProblem(input.problem), "Nothing was saved."],
      details: [input.problem],
    };
    case "approval": return {
      ...base, status: "waiting",
      lines: [`Slack is waiting for a workspace admin to approve "${input.appName}".`, "Your progress is saved. When the app is installed, start the install again and it continues from here."],
    };
    case "done": return {
      ...base, status: "ok",
      lines: [`"${input.appName}" is installed in the ${input.teamName ?? "chosen"} workspace.`],
      details: [`Slack app ID: ${input.appId}`, `Slack workspace ID: ${input.teamId}`],
    };
  }
}

export type SlackUrlsCardInput =
  | { stage: "checking"; eventsUrl: string }
  | { stage: "waiting-for-secret"; eventsUrl: string }
  | { stage: "verify"; pageUrl: string }
  | { stage: "failed"; problem: string; pageUrl: string }
  | { stage: "done"; eventsUrl: string };

/** FR-041: the Request URL check, live, and run again after a fix. */
export function slackUrlsCard(input: SlackUrlsCardInput): WizardCard {
  const base = { id: "slack-urls" as const, title: "The address Slack sends messages to" };
  const events = "Open Event Subscriptions";
  switch (input.stage) {
    case "checking": return { ...base, status: "running", lines: [`Checking that Slack can reach AgentX at ${input.eventsUrl}.`] };
    case "waiting-for-secret": return {
      ...base, status: "running",
      lines: [`Checking that Slack can reach AgentX at ${input.eventsUrl}.`, "AgentX can take up to 5 minutes to start using the new Signing Secret. Checking again every 15 seconds."],
    };
    case "verify": return {
      ...base, status: "waiting",
      lines: ["AgentX answers Slack's check.", "Open Event Subscriptions in your Slack app. If the address is not marked Verified, press Retry there, then answer below."],
      link: { url: input.pageUrl, label: events },
    };
    case "failed": return {
      ...base, status: "failed",
      lines: ["Slack's check of the address did not pass.", "Fix it, then choose Check again below."],
      details: [input.problem],
      link: { url: input.pageUrl, label: events },
    };
    case "done": return { ...base, status: "ok", lines: [`Slack has verified ${input.eventsUrl}.`] };
  }
}

/** A link that opens a Slack channel in the Slack app or the browser. */
export function slackChannelLink(teamId: string, channelId: string): string {
  return `https://slack.com/app_redirect?team=${encodeURIComponent(teamId)}&channel=${encodeURIComponent(channelId)}`;
}

export type AdminCardInput =
  | { stage: "signing-in"; who: string; createdEmail?: string }
  /** `retry: false` when the page cannot offer to sign in again: the problem is shown whole. */
  | { stage: "failed"; problem: string; retry?: false }
  | { stage: "done"; username: string };

/** FR-050: the admin user and the operator's sign-in. The sign-in page's address comes from the
 * run itself (the page's Next button), not from this card. */
export function adminCard(input: AdminCardInput): WizardCard {
  const base = { id: "admin" as const, title: "Your AgentX sign-in" };
  switch (input.stage) {
    case "signing-in": return {
      ...base, status: "waiting",
      lines: [
        ...(input.createdEmail === undefined ? [] : [`AgentX made your admin sign-in for ${input.createdEmail}. Look for an email with your temporary password; you choose your own when you first sign in.`]),
        `Sign in to AgentX as ${input.who} in the tab the Sign in button opens. This page moves on by itself when you have.`,
      ],
    };
    case "failed": return {
      ...base, status: "failed",
      lines: input.retry === false ? ["The sign-in did not finish."] : [onPageProblem(input.problem), "Choose Sign in again below."],
      details: [input.problem],
    };
    case "done": return { ...base, status: "ok", lines: [`You are signed in to AgentX as ${input.username}.`] };
  }
}

export function projectCard(input: { name: string; revision: number; repository?: string }): WizardCard {
  return {
    id: "project", title: "Your first project", status: "ok",
    lines: [`The project ${input.name} is set up${input.repository === undefined ? "" : ` for ${input.repository}`}.`],
    details: [`Project revision ${input.revision}`],
  };
}

export type ChannelCardInput =
  | { stage: "waiting"; channelName: string; botName: string }
  | { stage: "done"; channelName: string; projectName: string }
  /** The invite wait timed out. The page offers no retry, so the problem keeps its own next step. */
  | { stage: "failed"; channelName: string; problem: string };

export function channelCard(input: ChannelCardInput): WizardCard {
  const base = { id: "channel" as const, title: "Slack channel" };
  if (input.stage === "done") return { ...base, status: "ok", lines: [`AgentX answers in #${input.channelName} for ${input.projectName}.`] };
  if (input.stage === "failed") return { ...base, status: "failed", lines: [`AgentX's bot still cannot see #${input.channelName}.`], details: [input.problem] };
  return {
    ...base, status: "waiting",
    lines: [
      `AgentX's bot cannot see #${input.channelName} yet.`,
      `If #${input.channelName} is private, invite the bot in it with the command below. If it does not exist yet, create it in Slack.`,
      "This page moves on by itself when the bot can see it (up to 10 minutes).",
    ],
    commands: [{ label: "Invite the bot", command: `/invite @${input.botName}` }],
  };
}

export function connectorsCard(input: { projectName: string; connected: ReadonlyArray<{ label: string; warning?: string }> }): WizardCard {
  const lines = input.connected.length === 0
    ? [`No issue trackers are connected to ${input.projectName} yet. You can connect Linear, Jira or Asana later.`]
    : [
      `Connected to ${input.projectName}: ${input.connected.map((entry) => entry.label).join(", ")}.`,
      ...input.connected.flatMap((entry) => (entry.warning === undefined ? [] : [`Warning (${entry.label}): ${entry.warning}.`])),
    ];
  return { id: "connectors", title: "Issue trackers", status: "ok", lines };
}

export type AlertsCardInput =
  | { stage: "confirm"; shownAs: string }
  /** The run is polling for the confirmation itself, so the page needs no answer. */
  | { stage: "waiting"; shownAs: string }
  /** Subscribed; the test alarm is out and the operator answers whether it arrived. */
  | { stage: "testing"; shownAs: string }
  /** The test alarm failed. The page offers no retry for it, so the problem keeps its own next step. */
  | { stage: "failed"; problem: string }
  | { stage: "done"; shownAs: string }
  | { stage: "none" };

/** `shownAs` is an email address, or a webhook's display form (https://host/...), never its secret. */
export function alertsCard(input: AlertsCardInput): WizardCard {
  const base = { id: "alerts" as const, title: "Alerts" };
  const confirm = (shownAs: string): string => `Confirm the alert email for ${shownAs}: open the email from AWS Notifications and choose Confirm subscription.`;
  const webhook = ["A webhook confirms by opening the SubscribeURL that AWS sent it."];
  switch (input.stage) {
    case "confirm": return { ...base, status: "waiting", lines: [confirm(input.shownAs), "Then choose Check again below."], details: webhook };
    case "waiting": return { ...base, status: "waiting", lines: [confirm(input.shownAs), "This page moves on by itself when it is confirmed (up to 10 minutes)."], details: webhook };
    case "testing": return { ...base, status: "waiting", lines: [`Alerts go to ${input.shownAs}. AgentX sent a test alert; answer below whether it arrived.`] };
    case "failed": return { ...base, status: "failed", lines: ["The test alert could not be sent."], details: [input.problem] };
    case "done": return { ...base, status: "ok", lines: [`Alerts go to ${input.shownAs}, and the test alert arrived.`] };
    case "none": return { ...base, status: "info", lines: ["No alerts yet. The ready screen shows how to turn them on."] };
  }
}

export type ReplyCardInput =
  | { stage: "waiting"; channelName: string; channelId: string; teamId: string; botName: string; minutes: number }
  | { stage: "failed"; channelName: string; channelId: string; teamId: string; problem: string }
  | { stage: "done"; channelName: string; seconds: number };

/** FR-051: the test reply, with 15e's note on picking the right bot from Slack's mention list. */
export function replyCard(input: ReplyCardInput): WizardCard {
  const base = { id: "reply" as const, title: "First reply" };
  if (input.stage === "done") return { ...base, status: "ok", lines: [`AgentX replied in #${input.channelName} in ${input.seconds} seconds.`] };
  const link = { url: slackChannelLink(input.teamId, input.channelId), label: `Open #${input.channelName} in Slack` };
  if (input.stage === "failed") return { ...base, status: "failed", lines: ["AgentX did not reply.", "When it is fixed, choose Watch again below."], details: [input.problem], link };
  return {
    ...base, status: "waiting",
    lines: [
      `In #${input.channelName}, post a message that mentions @${input.botName}, for example "@${input.botName} what can you do?".`,
      `Type @ and pick ${input.botName} from Slack's list. If you see two bots with similar names, pick ${input.botName}.`,
      `Waiting up to ${input.minutes} minutes for AgentX to reply in the thread. This page moves on by itself.`,
    ],
    link,
  };
}

/** FR-058, FR-059 and #222: what works now, and every day-two command, each written so it works
 * exactly as shown (Plan ruling 4: the CLI's own path when it is not the published package). The
 * same facts as readyText, which the terminal and the page's outcome still show. */
export function readyCard(input: {
  env: string; controlPlaneUrl: string; progress: InstallProgress; botName: string; invocation: CliInvocation;
  root: boolean; alertsOn: boolean; created: string[]; logPath?: string;
}): WizardCard {
  const cli = (args: string) => cliCommandLine(input.invocation, `--env ${input.env} ${args}`);
  const { project } = input.progress;
  const connectors = input.progress.connectors ?? [];
  const teamId = project?.teamId ?? input.progress.slack?.teamId;
  return {
    id: "ready", title: "AgentX is ready", status: "ok",
    lines: [
      ...(project?.channelName === undefined ? [] : [`Try it: in #${project.channelName}, mention @${input.botName} and ask it something.`]),
      "Send your developers the sign-in command below. They run it once, then use AgentX from Claude Code, Codex or Cursor.",
      ...(input.invocation.published ? [] : ["The AgentX CLI is not published yet, so this command works on this computer. Other computers need their own copy of the AgentX CLI first."]),
      connectors.length === 0 ? "No issue trackers connected yet." : `Connected: ${connectors.map((entry) => CONNECTOR_LABELS[entry.type]).join(", ")}.`,
      ...connectors.flatMap((entry) => (entry.warning === undefined ? [] : [`Warning (${CONNECTOR_LABELS[entry.type]}): ${entry.warning}.`])),
      ...(input.alertsOn ? [] : ["Alerts are off. You can turn them on later; the day-two guide says how."]),
      ...(input.root ? ["You installed as the AWS root user. The day-two commands below need an admin user: AWS does not let the root user use the AgentX operator role."] : []),
      ...(input.logPath === undefined ? [] : [`Everything here is also in ${input.logPath}.`]),
    ],
    commands: [
      { label: "Developer sign-in", command: cliCommandLine(input.invocation, `login ${input.controlPlaneUrl}`) },
      { label: "Check the install", command: cli("doctor") },
      ...(project === undefined ? [] : [{ label: "Connect an issue tracker", command: cli(`connector add linear --project ${project.name}`) }]),
      { label: "Add a project", command: cli("project add") },
      ...(input.alertsOn ? [{ label: "Send a test alert", command: cli("alerts test") }] : []),
      { label: "Remove AgentX", command: cli("destroy") },
    ],
    ...(input.created.length === 0 ? {} : { details: [`What was created: ${input.created.join(", ")}`] }),
    ...(project?.channelId === undefined || project.channelName === undefined || teamId === undefined
      ? {} : { link: { url: slackChannelLink(teamId, project.channelId), label: `Open #${project.channelName} in Slack` } }),
  };
}
