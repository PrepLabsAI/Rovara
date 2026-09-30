// packages/cli/src/init/ui/cards.ts
// What each screen of the install page says (spec 040 FR-020 to FR-041, and phase 3's finishing
// screens). Every card is built here, from facts a step already has, so the page's words are
// tested in one place and the page only lays text out. No builder takes a secret, so no card can
// carry one (FR-012).
import { CONNECTOR_LABELS, type InstallProgress } from "../install-state.js";
import { DEDICATED_ACCOUNT_NOTE, type PrerequisiteCheck } from "../prerequisites.js";
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

export function awsCard(input: { account: string; arn: string; region: string; profile?: string }): WizardCard {
  return {
    id: "aws", title: "AWS account", status: "ok",
    lines: [
      `AgentX installs into account ${input.account} in ${input.region}.`,
      `Signed in as ${input.arn}${input.profile === undefined ? "" : ` (profile ${input.profile})`}.`,
      DEDICATED_ACCOUNT_NOTE,
    ],
  };
}

/** FR-021: the session is missing or expired. `signIn` is the command Sign in runs, when the
 * profile has one; `ranProblem` is why the last sign-in could not run. */
export function awsSignedOutCard(input: { profile?: string; problem: string; signIn?: string; ranProblem?: string }): WizardCard {
  const next = input.signIn !== undefined
    ? `Choose Sign in to run ${input.signIn}; a browser tab opens for it. If no tab opens, the terminal running agentx init shows the address and code.`
    : input.profile === undefined
      ? "Sign in again in a terminal, then choose Check again."
      : `Update the credentials of profile ${input.profile} in a terminal, then choose Check again.`;
  return {
    id: "aws", title: "AWS account", status: "failed",
    lines: [
      input.profile === undefined ? "AgentX cannot use your AWS sign-in." : `AgentX cannot use the AWS sign-in of profile ${input.profile}.`,
      input.problem,
      ...(input.ranProblem === undefined ? [] : [input.ranProblem]),
      next,
    ],
  };
}

/** The prerequisites as a checklist (FR-023): each check with its own result, as it finishes. */
export function prerequisitesCard(input: { status: "running" | "ok" | "failed"; checks: readonly PrerequisiteCheck[] }): WizardCard {
  const lines = input.status === "running"
    ? ["Checking this account and region before anything is created."]
    : input.status === "ok"
      ? ["Every check passed."]
      : ["Nothing has been created. Fix each item marked with a cross, then answer Yes below to check again."];
  return { id: "prerequisites", title: "Prerequisites", status: input.status, lines, checks: input.checks.map((check) => ({ ...check })) };
}

export type GitHubCardInput =
  | { stage: "create"; appName: string; account: string; startUrl: string }
  | { stage: "install"; slug: string; account: string; installUrl: string }
  | { stage: "repositories"; slug: string; account: string; settingsUrl: string }
  | { stage: "done"; slug: string; account: string };

/** FR-030 and FR-031: creating the app, then the installation wait, as one card. */
export function githubCard(input: GitHubCardInput): WizardCard {
  const base = { id: "github" as const, title: "GitHub App" };
  switch (input.stage) {
    case "create": return {
      ...base, status: "waiting",
      lines: [`Create the GitHub App "${input.appName}" for ${input.account}. GitHub opens with everything filled in; press Create GitHub App.`, "This page moves on by itself once GitHub sends you back."],
      link: { url: input.startUrl, label: "Create the GitHub App" },
    };
    case "install": return {
      ...base, status: "waiting",
      lines: [`Install ${input.slug} on ${input.account} and choose the repositories AgentX may use.`, "Waiting for the installation. This page moves on by itself."],
      link: { url: input.installUrl, label: "Install the app and choose repositories" },
    };
    case "repositories": return {
      ...base, status: "waiting",
      lines: [`${input.slug} is installed but can see no repositories.`, "Choose at least one. This page moves on by itself."],
      link: { url: input.settingsUrl, label: "Choose repositories" },
    };
    case "done": return { ...base, status: "ok", lines: [`${input.slug} is installed on ${input.account}.`] };
  }
}

export type SlackCardInput =
  | { stage: "create"; appName: string; createUrl: string }
  | { stage: "credentials"; appName: string }
  | { stage: "bot"; user: string; team: string }
  /** `retry: false` when the page cannot offer a paste again: the problem is shown whole, with its
   * advice to run agentx init again. */
  | { stage: "refused"; problem: string; retry?: false }
  | { stage: "approval"; appName: string; rerun: string }
  | { stage: "done"; appId: string; teamId: string };

/** FR-040: the Slack app, from the create button to its stored credentials. */
export function slackAppCard(input: SlackCardInput): WizardCard {
  const base = { id: "slack" as const, title: "Slack app" };
  switch (input.stage) {
    case "create": return {
      ...base, status: "waiting",
      lines: [
        `Create the Slack app "${input.appName}" from AgentX's manifest: pick the workspace, press Next, then Create, then Install to Workspace.`,
        "If your workspace needs an admin to approve new apps, choose Request to Install, then answer Not yet below.",
      ],
      link: { url: input.createUrl, label: "Create the Slack app" },
    };
    case "credentials": return {
      ...base, status: "waiting",
      lines: [
        "Paste the Bot User OAuth Token (OAuth & Permissions) and the Signing Secret (Basic Information, App Credentials) below.",
        "Both go straight to AWS Secrets Manager and are never shown again.",
      ],
    };
    case "bot": return { ...base, status: "waiting", lines: [`Slack says this token belongs to the bot @${input.user} in workspace ${input.team}.`] };
    case "refused": return {
      ...base, status: "failed",
      lines: [input.retry === false ? input.problem : onPageProblem(input.problem), ...(/nothing was saved/i.test(input.problem) ? [] : ["Nothing was saved."])],
    };
    case "approval": return { ...base, status: "waiting", lines: [`Slack is waiting for a workspace admin to approve "${input.appName}".`, `Once it is installed, run ${input.rerun}; it continues here.`] };
    case "done": return { ...base, status: "ok", lines: [`Slack app ${input.appId} is installed in workspace ${input.teamId}.`] };
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
  const base = { id: "slack-urls" as const, title: "Slack Request URL" };
  const events = "Open Event Subscriptions";
  switch (input.stage) {
    case "checking": return { ...base, status: "running", lines: [`Sending ${input.eventsUrl} a signed test request, the way Slack will.`] };
    case "waiting-for-secret": return {
      ...base, status: "running",
      lines: [`Sending ${input.eventsUrl} a signed test request, the way Slack will.`, "The Slack service keeps the old signing secret for up to 5 minutes; checking again every 15 seconds."],
    };
    case "verify": return {
      ...base, status: "waiting",
      lines: ["AgentX answers Slack's URL check.", "Open Event Subscriptions. If the Request URL is not marked Verified, press Retry there, then answer below."],
      link: { url: input.pageUrl, label: events },
    };
    case "failed": return {
      ...base, status: "failed",
      lines: [onPageProblem(input.problem), "Fix it, then answer Yes below to run the check again."],
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
  const base = { id: "admin" as const, title: "Admin user" };
  switch (input.stage) {
    case "signing-in": return {
      ...base, status: "waiting",
      lines: [
        ...(input.createdEmail === undefined ? [] : [`Created your admin user ${input.createdEmail}. Cognito emailed a temporary password to ${input.createdEmail}; you choose your own password when you first sign in.`]),
        `Sign in to AgentX as ${input.who} in the tab the button opens. This page moves on by itself once you have.`,
      ],
    };
    case "failed": return {
      ...base, status: "failed",
      lines: input.retry === false ? [input.problem] : [onPageProblem(input.problem), "Answer Yes below to sign in again."],
    };
    case "done": return { ...base, status: "ok", lines: [`Signed in to AgentX as ${input.username}.`] };
  }
}

export function projectCard(input: { name: string; revision: number; repository?: string }): WizardCard {
  return {
    id: "project", title: "First project", status: "ok",
    lines: [`Project ${input.name}, revision ${input.revision}${input.repository === undefined ? "" : `, for ${input.repository}`}, runs on EC2 workers.`],
  };
}

export type ChannelCardInput =
  | { stage: "waiting"; channelName: string; botUserId: string }
  | { stage: "done"; channelName: string; projectName: string };

export function channelCard(input: ChannelCardInput): WizardCard {
  const base = { id: "channel" as const, title: "Slack channel" };
  if (input.stage === "done") return { ...base, status: "ok", lines: [`#${input.channelName} is bound to project ${input.projectName}.`] };
  return {
    ...base, status: "waiting",
    lines: [
      `The bot cannot see #${input.channelName} yet.`,
      `If #${input.channelName} is private, type /invite <@${input.botUserId}> in it; if it does not exist, create it. This page moves on by itself (up to 10 minutes).`,
    ],
  };
}

export function connectorsCard(input: { projectName: string; connected: ReadonlyArray<{ label: string; warning?: string }> }): WizardCard {
  const lines = input.connected.length === 0
    ? [`No connectors on ${input.projectName} yet. You can add Linear, Jira or Asana later.`]
    : [
      `Connected to ${input.projectName}: ${input.connected.map((entry) => entry.label).join(", ")}.`,
      ...input.connected.flatMap((entry) => (entry.warning === undefined ? [] : [`Warning (${entry.label}): ${entry.warning}.`])),
    ];
  return { id: "connectors", title: "Connectors", status: "ok", lines };
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
  const confirm = (shownAs: string): string =>
    `Confirm the alert subscription for ${shownAs}: open the email from AWS Notifications and choose Confirm subscription (a webhook confirms by opening the SubscribeURL that SNS sent it).`;
  switch (input.stage) {
    case "confirm": return { ...base, status: "waiting", lines: [confirm(input.shownAs), "Then answer Yes below to check again."] };
    case "waiting": return { ...base, status: "waiting", lines: [confirm(input.shownAs), "This page moves on by itself once it is confirmed (up to 10 minutes)."] };
    case "testing": return { ...base, status: "waiting", lines: [`Alerts are subscribed for ${input.shownAs}. AgentX sent a test alarm; answer below whether it arrived.`] };
    case "failed": return { ...base, status: "failed", lines: [input.problem] };
    case "done": return { ...base, status: "ok", lines: [`Alerts go to ${input.shownAs}, and the test alarm arrived.`] };
    case "none": return { ...base, status: "info", lines: ["No alert address yet. Set one later with agentx config set alerts.address."] };
  }
}

export type ReplyCardInput =
  | { stage: "waiting"; channelName: string; channelId: string; teamId: string; botUserId: string; minutes: number }
  | { stage: "failed"; channelName: string; channelId: string; teamId: string; problem: string }
  | { stage: "done"; channelName: string; seconds: number };

/** FR-051: the test reply, with 15e's note on picking the right bot from Slack's mention list. */
export function replyCard(input: ReplyCardInput): WizardCard {
  const base = { id: "reply" as const, title: "Test reply" };
  if (input.stage === "done") return { ...base, status: "ok", lines: [`AgentX replied in #${input.channelName} in ${input.seconds} seconds.`] };
  const link = { url: slackChannelLink(input.teamId, input.channelId), label: `Open #${input.channelName} in Slack` };
  if (input.stage === "failed") return { ...base, status: "failed", lines: [onPageProblem(input.problem), "Fix it, then answer Yes below to watch for a reply again."], link };
  return {
    ...base, status: "waiting",
    lines: [
      `In #${input.channelName}, post a message that mentions the bot, for example "@<the bot> what can you do?".`,
      `Type @ and pick the bot from Slack's mention list: a workspace that had an older AgentX app shows two bots with similar names, and this one's member ID is ${input.botUserId}.`,
      `Waiting up to ${input.minutes} minutes for AgentX to reply in its thread. This page moves on by itself.`,
    ],
    link,
  };
}

/** FR-052 and Q10: what works now, then the optional commands under "Later, if you want more:".
 * The same facts as readyText, which the terminal and the page's outcome still show. */
export function readyCard(input: { env: string; controlPlaneUrl: string; progress: InstallProgress }): WizardCard {
  const { env, progress } = input;
  const cli = `agentx --env ${env}`;
  const { project, slack } = progress;
  const connectors = progress.connectors ?? [];
  const teamId = project?.teamId ?? slack?.teamId;
  return {
    id: "ready", title: "AgentX is ready", status: "ok",
    lines: [
      `AgentX environment ${env} is ready.`,
      ...(project?.channelName === undefined || slack === undefined ? [] : [`Talk to it: mention the bot (member ID ${slack.botUserId}) in #${project.channelName}, project ${project.name}, revision ${project.revision}.`]),
      `Developers sign in from their AI tools with: npx @charterarc/agentx login ${input.controlPlaneUrl}`,
      connectors.length === 0 ? "No connectors yet." : `Connected: ${connectors.map((entry) => CONNECTOR_LABELS[entry.type]).join(", ")}.`,
      ...connectors.flatMap((entry) => (entry.warning === undefined ? [] : [`Warning (${CONNECTOR_LABELS[entry.type]}): ${entry.warning}.`])),
      "Later, if you want more:",
      ...(project === undefined ? [] : [`More connectors: ${cli} connector add linear|jira|asana --project ${project.name}`]),
      `More projects: ${cli} project add, then ${cli} channel add`,
      `A test alarm any time: ${cli} alerts test`,
    ],
    ...(project?.channelId === undefined || project.channelName === undefined || teamId === undefined
      ? {} : { link: { url: slackChannelLink(teamId, project.channelId), label: `Open #${project.channelName} in Slack` } }),
  };
}
