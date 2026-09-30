// packages/cli/src/init/ui/cards.ts
// What each screen of the install page says (spec 040 FR-020 to FR-041, and phase 3's finishing
// screens). Every card is built here, from facts a step already has, so the page's words are
// tested in one place and the page only lays text out. No builder takes a secret, so no card can
// carry one (FR-012).
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
    ? `Choose Sign in to run ${input.signIn}; a browser tab opens for it.`
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
