// packages/cli/src/init/ui/question-copy.ts
// Spec 048 FR-010, FR-011 and FR-080: the install page's words for every question on the default
// path, the retry questions and the Slack questions. Looked up by kind and flag, or by the
// question's own text where it has no flag (every confirm). The terminal never reads this, so its
// questions and every --yes run stay exactly as they were. Phase 2 adds the Advanced settings
// (your own OIDC, OpenRouter, Linear, Jira, Asana) when they move under one heading.
import type { QuestionHelp } from "../prompts.js";
import type { QuestionKind } from "./protocol.js";

/** The alert questions' shared flag text (answers.ts). */
export const ALERT_FLAG = "--alert-email (or --alert-webhook-file, --alert-webhook-env, --no-alerts)";

type HelpSource = QuestionHelp | ((match: RegExpExecArray) => QuestionHelp);
export interface QuestionCopyEntry { kind: QuestionKind; flag?: string; text?: RegExp; help: HelpSource }

export const QUESTION_COPY: readonly QuestionCopyEntry[] = [
  // Spec 048 FR-020: the settings, as one form.
  { kind: "form", text: /^Your settings$/, help: { label: "Your settings", why: "Answer these four. Everything else has a recommended value you can change under Advanced settings.", submitLabel: "Review the plan" } },
  { kind: "ask", flag: "--env", help: { label: "Install name", why: "Names this install in AWS, GitHub and Slack, so one account can hold more than one.", example: "production" } },
  {
    kind: "choose", flag: "AWS_PROFILE", text: /sign-in is missing or has expired/,
    help: { label: "Your AWS sign-in has ended", why: "AgentX needs a current AWS sign-in to look at your account.", buttons: true, choiceLabels: { signin: "Sign in again", retry: "I signed in another way, check again", stop: "Stop for now" } },
  },
  { kind: "choose", flag: "AWS_PROFILE", help: { label: "Which AWS profile should AgentX use?", why: "AgentX installs into the AWS account this profile signs in to.", example: "default" } },
  { kind: "choose", flag: "--continue-as-root", help: { label: "Continue as the AWS root user?", why: "AgentX works with the root user. You can also stop, sign in as an admin user, and start again.", buttons: true } },
  { kind: "choose", flag: "--region", help: { label: "Which AWS region?", why: "AgentX runs in this region. Pick the one closest to your team.", learnMoreUrl: "https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html" } },
  { kind: "choose", flag: "--engine", help: { label: "How should AgentX deploy?", why: "Published templates need nothing else installed on this computer.", choiceLabels: { templates: "Published templates (recommended)", cdk: "From AgentX's source code, for contributors" } } },
  { kind: "choose", flag: "--identity", help: { label: "How will you sign in to AgentX?", why: "This is your own admin sign-in. Developers sign in with Slack, later in the install.", choiceLabels: { cognito: "AgentX sign-in, created for you (recommended)", oidc: "Your company sign-in (Okta, Entra, Google)" } } },
  { kind: "choose", flag: "--model-provider", help: { label: "Where should AgentX run its AI models?", why: "Amazon Bedrock keeps every model request inside your AWS account.", choiceLabels: { "amazon-bedrock": "Amazon Bedrock (recommended)", openrouter: "OpenRouter" } } },
  { kind: "choose", flag: "--orchestrator-model", help: { label: "Main model", why: "The main model reads each Slack message and decides what to do." } },
  { kind: "choose", flag: "--classifier-model", help: { label: "Safety check model", why: "The safety check model looks at every action before AgentX takes it." } },
  { kind: "ask", flag: "--orchestrator-model", help: { label: "Main model id", why: "The model id exactly as your provider lists it.", example: "us.anthropic.claude-sonnet-4-6" } },
  { kind: "ask", flag: "--classifier-model", help: { label: "Safety check model id", why: "The model id exactly as your provider lists it.", example: "amazon.nova-lite-v1:0" } },
  { kind: "choose", flag: "--worker-model", help: { label: "Coding model", why: "The coding model writes and tests code in your repositories." } },
  { kind: "ask", flag: "--worker-model", help: { label: "Coding model", why: "The coding model writes and tests code in your repositories.", example: "us.anthropic.claude-sonnet-4-6", defaultText: "Claude Sonnet 4.6" } },
  { kind: "ask", flag: "--permission-boundary", help: { label: "Permission boundary (advanced)", why: "Only if your company requires every IAM role to carry its own boundary policy. Your platform team gives you its address." } },
  { kind: "ask", flag: "--operator-principal", help: { label: "Who may run day-two commands (advanced)", why: "Leave it empty and anyone with admin rights in this AWS account can run them." } },
  { kind: "choose", flag: ALERT_FLAG, help: { label: "Where should AgentX send alerts?", why: "AgentX tells you here when something stops working.", choiceLabels: { email: "An email address (recommended)", webhook: "A PagerDuty or Opsgenie address (kept secret)", none: "Nowhere for now. Nobody is told when AgentX stops working." } } },
  { kind: "ask", flag: ALERT_FLAG, help: { label: "Alert email address", why: "AWS sends a confirmation email here first. Confirm it to start getting alerts.", example: "ops@example.com", hint: "Optional. Leave empty to use your email." } },
  { kind: "ask", flag: "--budget", help: { label: "Monthly budget alert, in US dollars", why: "AWS emails you when this month's costs pass 80% of it. 0 turns it off." } },
  { kind: "choose", flag: "--budget-scope", help: { label: "Which costs should the budget count?", why: "The whole account is simplest. Counting only AgentX needs a billing tag that can take a day to start counting.", choiceLabels: { account: "The whole account (recommended)", tag: "Only AgentX's costs (needs a billing tag)" } } },
  { kind: "ask", flag: "--github-account", help: { label: "GitHub owner", why: "The GitHub organization or user that will own AgentX's GitHub app.", example: "acme" } },
  // Asked only when GitHub could not say what the owner is (FR-020).
  { kind: "choose", text: /^Is .+ an organization or a personal account\?$/, flag: "--github-account-type", help: { label: "Is it an organization or a personal account?", why: "GitHub could not tell AgentX, and keeps apps in a different place for each.", choiceLabels: { organization: "An organization", user: "A personal account" } } },
  { kind: "ask", flag: "--github-app-name", help: { label: "App name", why: "The name of AgentX's app in GitHub, and the default for Slack. GitHub needs it to be unique.", example: "AgentX acme (production)", hint: "Optional. Leave empty to use AgentX, your GitHub owner and the install name." } },
  { kind: "ask", flag: "--slack-app-name", help: { label: "Slack app name", why: "How AgentX's app shows in your Slack workspace.", example: "AgentX acme (production)" } },
  { kind: "choose", flag: "--slack-app-posted-messages", help: { label: "Answer messages other apps post for people?", why: "Some teams post to Slack through tools that use a person's own Slack token. AgentX never answers itself or other bots.", choiceLabels: { accept: "Yes, answer them (recommended)", ignore: "No, only messages typed in Slack" } } },
  { kind: "choose", flag: "--slack-install", help: { label: "Is the Slack app installed in your workspace?", why: "AgentX needs the app installed before it can use its token.", buttons: true, choiceLabels: { installed: "Installed, continue", approval: "My workspace needs an admin to approve it" } } },
  { kind: "secret", flag: "--slack-bot-token", help: { label: "Bot User OAuth Token", why: "Slack shows it under OAuth & Permissions. It starts with xoxb-.", example: "xoxb-..." } },
  { kind: "secret", flag: "--slack-signing-secret", help: { label: "Signing Secret", why: "Slack shows it under Basic Information, App Credentials. Press Show, then copy it." } },
  { kind: "choose", flag: "--signin", help: { label: "How will developers sign in from their AI tools?", why: "Developers sign in once from Claude Code, Codex or Cursor.", choiceLabels: { slack: "Sign in with Slack (recommended)", oidc: "Your company sign-in", both: "Both" } } },
  { kind: "ask", flag: "--slack-client-id", help: { label: "Client ID", why: "Slack shows it under Basic Information, App Credentials: two numbers joined by a dot.", example: "1111111111.2222222222222" } },
  { kind: "secret", flag: "--slack-client-secret", help: { label: "Client Secret", why: "Under Basic Information, App Credentials, next to the Client ID. Press Show, then copy it." } },
  { kind: "ask", flag: "--admin-email", help: { label: "Your email", why: "AgentX makes your admin sign-in with it, and sends alerts here unless you choose otherwise.", example: "you@example.com" } },
  { kind: "choose", flag: "--repository", help: { label: "Which repository is your first project?", why: "AgentX works in this repository first. You can add more later." } },
  { kind: "ask", flag: "--project-name", help: { label: "Project name", why: "How AgentX names this project in Slack.", example: "payments-api" } },
  { kind: "ask", flag: "--setup-command", help: { label: "Setup command", why: "AgentX runs it before it changes code.", example: "npm ci", hint: "Optional. Leave empty if the project needs none." } },
  { kind: "ask", flag: "--test-command", help: { label: "Test command", why: "AgentX runs it to check its own work.", example: "npm test", hint: "Optional. Leave empty if the project has none." } },
  { kind: "ask", flag: "--channel", help: { label: "Which Slack channel?", why: "AgentX answers in this channel for this project.", example: "payments" } },
  { kind: "ask", text: /^Paste that address/, help: { label: "Paste the address GitHub sent you to", why: "Only needed when GitHub could not send you back to this page." } },
  { kind: "secret", flag: "--github-private-key", help: { label: "GitHub app private key", why: "GitHub offers it as a download on the app's page. Paste the whole file." } },
  // Spec 048 FR-032: an app GitHub made, whose key a crash kept from reaching Secrets Manager, found again on resume.
  { kind: "choose", flag: "--github-app-recovery", help: { label: "Finish with the GitHub app, or replace it?", why: "The card above says what each choice removes.", buttons: true, choiceLabels: { finish: "Finish with this app", replace: "Replace it" } } },
  { kind: "confirm", text: /^Have you deleted .+ on GitHub\?$/, help: { label: "Deleted the old app on GitHub?", why: "GitHub app names are unique, so the new app needs the old one gone first.", yesLabel: "It is deleted", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Create all of this\?$/, help: { label: "Create AgentX with this plan?", why: "Nothing is created until you press Create AgentX.", yesLabel: "Create AgentX", noLabel: "Cancel the install" } },
  // Spec 048 FR-029: on the page, the plan's confirm is these two buttons, not a yes/no (the
  // terminal keeps the confirm above, unchanged).
  { kind: "choose", flag: "--plan", help: { label: "Create AgentX with this plan?", why: "Nothing is created until you press Create AgentX.", buttons: true, choiceLabels: { create: "Create AgentX", change: "Change answers" } } },
  // Fix round 1: "--on-check-failure" is a copy key for this entry's lookup, not a real CLI flag;
  // the terminal never asks this question (retry.ts's checkWithChangeOnPage throws straight away
  // without a page), so there is no flag for someone to look for.
  { kind: "choose", flag: "--on-check-failure", help: { label: "Fix what is marked above", why: "Nothing has been created yet. Change an answer, or fix it elsewhere and check again.", buttons: true, choiceLabels: { change: "Change answers", retry: "Check again", stop: "Stop for now" } } },
  { kind: "confirm", text: /^Check your AWS account again\?$/, help: { label: "Fix the items marked above, then check again", why: "Nothing has been created yet.", yesLabel: "Check again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Check the prerequisites again\?$/, help: { label: "Fix the items marked above, then check again", why: "Nothing has been created yet.", yesLabel: "Check again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Is this the AgentX bot in the right workspace\?$/, help: { label: "Is this the right bot and workspace?", why: "This is the bot the token you pasted belongs to.", yesLabel: "Yes, continue", noLabel: "That is the wrong app" } },
  { kind: "confirm", text: /^Does Slack show the Request URL as Verified\?$/, help: { label: "Does Slack show the address as Verified?", why: "Slack checks the address it sends messages to.", yesLabel: "It shows Verified", noLabel: "It still shows an error" } },
  { kind: "confirm", text: /^Apply this change\?$/, help: { label: "Turn on developer sign-in now?", why: "This updates AgentX's sign-in settings in AWS. It takes about a minute.", yesLabel: "Turn it on", noLabel: "Not now" } },
  { kind: "confirm", text: /^Use these commands\?/, help: { label: "Use these setup and test commands?", why: "AgentX runs them before it changes code, and to check its work.", yesLabel: "Use them", noLabel: "Change them" } },
  { kind: "confirm", text: /^Connect (Linear|Jira|Asana) to .+ now\?/, help: (match) => ({ label: `Connect ${match[1] ?? "it"} to this project now?`, why: "You can also connect it later.", yesLabel: `Connect ${match[1] ?? "it"}`, noLabel: "Skip for now" }) },
  { kind: "confirm", text: /^Did a test alarm named .+ arrive at (.+)\?$/, help: (match) => ({ label: `Did the test alert arrive at ${match[1] ?? "your address"}?`, why: "AgentX just sent one, so you know alerts reach you.", yesLabel: "It arrived", noLabel: "It did not arrive" }) },
  { kind: "confirm", text: /^Have you confirmed the subscription\?/, help: { label: "Confirmed the alert email?", why: "Open the email from AWS Notifications and choose Confirm subscription.", yesLabel: "Check again", noLabel: "Skip for now" } },
  { kind: "confirm", text: /^Paste the Slack bot token and signing secret again\?$/, help: { label: "Paste the two Slack values again?", why: "Nothing was saved. Copy both values from the Slack app you just made.", yesLabel: "Paste them again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Run the Request URL check again\?$/, help: { label: "Check the address again?", why: "Fix what is marked above first.", yesLabel: "Check again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Sign in again\?$/, help: { label: "Sign in again?", why: "The sign-in did not finish.", yesLabel: "Sign in again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Watch for the reply again\?$/, help: { label: "Watch for the reply again?", why: "Post the message again first if it was not answered.", yesLabel: "Watch again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Environment .+ is locked by/, help: { label: "Another install with this name is running", why: "Take it over only if that run has stopped.", yesLabel: "Take over", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Run cdk bootstrap .+ now\?$/, help: { label: "Prepare this region for deploying from source code?", why: "This creates the CDK toolkit stack once in this account and region.", yesLabel: "Prepare it", noLabel: "Stop for now" } },
];

/** The page's words for one question: the catalog's entry, with the caller's own help on top. */
export function questionHelp(input: { kind: QuestionKind; text: string; flag?: string; given?: QuestionHelp }): QuestionHelp {
  for (const entry of QUESTION_COPY) {
    if (entry.kind !== input.kind) continue;
    if (entry.flag !== undefined && entry.flag !== input.flag) continue;
    const match = entry.text === undefined ? undefined : entry.text.exec(input.text) ?? undefined;
    if (entry.text !== undefined && match === undefined) continue;
    const base = typeof entry.help === "function" ? entry.help(match ?? (Object.assign([input.text], { index: 0, input: input.text }) as RegExpExecArray)) : entry.help;
    return { ...base, ...input.given };
  }
  return { ...input.given };
}

/** FR-010: what an empty field means. A field with no default has no hint. */
export function pageHint(defaultValue: string | undefined, help: QuestionHelp): string | undefined {
  if (help.hint !== undefined) return help.hint;
  if (defaultValue === undefined) return undefined;
  if (defaultValue === "") return "Optional. Leave empty to use AgentX's default.";
  return `Leave empty to use ${help.defaultText ?? defaultValue}.`;
}
