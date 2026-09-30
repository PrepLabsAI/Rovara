// packages/cli/src/init/aws-account.ts
// FR-020 to FR-022 (Q9): which AWS profile the install uses, which account and role that is, and
// signing in again when the session has expired. Only the page asks the profile question; the
// terminal path uses the ambient credentials exactly as before. A profile's keys are never read
// into anything this module returns.
import { readFile as readFileFromDisk } from "node:fs/promises";
import { join } from "node:path";
import { AgentXError } from "@agentx/contracts";
import { cliErrorFor } from "../deploy/commands.js";
import type { CommandRunner } from "../deploy/cdk-engine.js";
import type { CallerIdentity } from "../environments/adopt.js";
import type { InstallSurface } from "./context.js";
import type { Prompter } from "./prompts.js";
import { problemText } from "./retry.js";
import { awsCard, awsSignedOutCard } from "./ui/cards.js";

export type AwsProfileKind = "sso" | "login" | "keys" | "other";
export interface AwsProfile { name: string; kind: AwsProfileKind; region?: string }

const KIND_LABELS: Record<AwsProfileKind, string> = { sso: "IAM Identity Center", login: "aws login", keys: "access keys", other: "a role or a process" };

/** An AWS config or credentials file: `[section]` headers, and `key = value` lines, keys lower-cased. */
export function parseAwsIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      const name = (header[1] ?? "").trim();
      current = sections.get(name) ?? new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (pair !== null && current !== undefined) current.set((pair[1] ?? "").trim().toLowerCase(), (pair[2] ?? "").trim());
  }
  return sections;
}

function kindOf(values: Map<string, string>): AwsProfileKind {
  if (values.has("sso_session") || values.has("sso_start_url")) return "sso";
  if (values.has("login_session")) return "login";
  if (values.has("aws_access_key_id")) return "keys";
  return "other";
}

/** Every profile in the AWS CLI's two files, `default` first, then by name. Only names, how each
 * signs in, and a region: never a key. */
export async function listAwsProfiles(input: { home: string; processEnv: NodeJS.ProcessEnv; readFile?: (path: string) => Promise<string> }): Promise<AwsProfile[]> {
  const read = input.readFile ?? ((path: string) => readFileFromDisk(path, "utf8"));
  const optional = async (path: string) => { try { return await read(path); } catch { return ""; } };
  const config = parseAwsIni(await optional(input.processEnv.AWS_CONFIG_FILE ?? join(input.home, ".aws", "config")));
  const credentials = parseAwsIni(await optional(input.processEnv.AWS_SHARED_CREDENTIALS_FILE ?? join(input.home, ".aws", "credentials")));
  const profiles = new Map<string, AwsProfile>();
  for (const [section, values] of config) {
    // "sso-session x" and "services x" sections are not profiles.
    const name = section === "default" ? "default" : section.startsWith("profile ") ? section.slice("profile ".length).trim() : "";
    if (name === "") continue;
    const region = values.get("region");
    profiles.set(name, { name, kind: kindOf(values), ...(region === undefined || region === "" ? {} : { region }) });
  }
  for (const [name, values] of credentials) {
    if (!values.has("aws_access_key_id")) continue;
    const known = profiles.get(name);
    if (known === undefined) profiles.set(name, { name, kind: "keys" });
    else if (known.kind === "other") profiles.set(name, { ...known, kind: "keys" });
  }
  return [...profiles.values()].sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : a.name.localeCompare(b.name)));
}

/** FR-020: the profile the install uses, put in AWS_PROFILE before any AWS client is built. None
 * when keys in the environment win over every profile, or when this machine has no profile. */
export async function pickAwsProfile(input: { profiles: AwsProfile[]; processEnv: NodeJS.ProcessEnv; prompter: Prompter }): Promise<AwsProfile | undefined> {
  const { processEnv } = input;
  if (processEnv.AWS_ACCESS_KEY_ID !== undefined) return undefined;
  // An AWS_PROFILE this module cannot list (a credentials-file section with credential_process or
  // role_arn, say) is still the operator's choice: it is offered, and it is the default, rather
  // than silently replaced by another account's profile.
  const named = processEnv.AWS_PROFILE;
  const profiles = named === undefined || named === "" || input.profiles.some((profile) => profile.name === named)
    ? input.profiles
    : [{ name: named, kind: "other" as const }, ...input.profiles];
  const first = profiles[0];
  if (first === undefined) return undefined;
  const current = profiles.find((profile) => profile.name === (processEnv.AWS_PROFILE ?? "default")) ?? first;
  let picked = current;
  if (profiles.length > 1) {
    const name = await input.prompter.choose<string>(
      "AWS profile to install with",
      profiles.map((profile) => ({ value: profile.name, label: `${profile.name} (${KIND_LABELS[profile.kind]})` })),
      { flag: "AWS_PROFILE", defaultValue: current.name },
    );
    picked = profiles.find((profile) => profile.name === name) ?? current;
  }
  processEnv.AWS_PROFILE = picked.name;
  return picked;
}

/** FR-021: the AWS CLI command that signs this profile in again, when it has one. */
export function signInCommand(profile: AwsProfile): { command: "aws"; args: string[]; display: string } | undefined {
  const args = profile.kind === "sso" ? ["sso", "login", "--profile", profile.name] : profile.kind === "login" ? ["login", "--profile", profile.name] : undefined;
  return args === undefined ? undefined : { command: "aws", args, display: `aws ${args.join(" ")}` };
}

/** Why the sign-in could not run, in one line: the runner's message names the command already
 * ("aws sso login --profile dev could not start: ...") and may end in a multi-line stderr tail. */
function ranProblemText(display: string, error: unknown): string {
  const first = (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]?.trim().replace(/:$/, "") ?? "";
  return first.startsWith(display) ? first : `could not run ${display}: ${first}`;
}

const isSignInProblem = (error: unknown): boolean => {
  const mapped = cliErrorFor(error);
  return mapped instanceof AgentXError && mapped.code === "AUTH_REQUIRED";
};

/** The caller, shown on the page (FR-020). On the page, a missing or expired session offers the
 * profile's sign-in and asks AWS again (FR-021); `identity` builds a fresh client each time, so a
 * credential the SDK failed to load is looked up again. Without a page, the first failure is
 * thrown exactly as before. */
export async function resolveCaller(input: {
  identity: () => CallerIdentity; region: string; prompter: Prompter; runner: CommandRunner; surface?: InstallSurface; profile?: AwsProfile;
}): Promise<{ account: string; arn: string }> {
  const { surface, profile } = input;
  const signIn = profile === undefined ? undefined : signInCommand(profile);
  let ranProblem: string | undefined;
  for (;;) {
    try {
      const caller = await input.identity().get();
      surface?.card(awsCard({ ...caller, region: input.region, ...(profile === undefined ? {} : { profile: profile.name }) }));
      return caller;
    } catch (error) {
      if (surface === undefined || !isSignInProblem(error)) throw error;
      surface.card(awsSignedOutCard({
        problem: problemText(error),
        ...(profile === undefined ? {} : { profile: profile.name }),
        ...(signIn === undefined ? {} : { signIn: signIn.display }),
        ...(ranProblem === undefined ? {} : { ranProblem }),
      }));
      ranProblem = undefined;
      const next = await input.prompter.choose<"signin" | "retry" | "stop">("Your AWS sign-in is missing or has expired. What next?", [
        ...(signIn === undefined ? [] : [{ value: "signin" as const, label: `Sign in (${signIn.display})` }]),
        { value: "retry", label: "I signed in another way; check again" },
        { value: "stop", label: "Stop the install" },
      ], { flag: "AWS_PROFILE", defaultValue: signIn === undefined ? "retry" : "signin" });
      if (next === "stop") throw error;
      if (next === "signin" && signIn !== undefined) {
        try {
          await input.runner.run(signIn.command, signIn.args, { cwd: process.cwd(), display: signIn.display });
        } catch (runError) {
          ranProblem = ranProblemText(signIn.display, runError);
        }
      }
    }
  }
}
