// tests/contract/init-aws-account.test.ts
// FR-020 and FR-021 (Q9): the AWS screen lists this machine's profiles, shows the account the
// install lands in, and signs in again when the session has expired, instead of ending the run.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listAwsProfiles, parseAwsIni, pickAwsProfile, resolveCaller, signInCommand, type AwsProfile } from "../../packages/cli/src/init/aws-account.js";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { ADMIN_USER_GUIDE_URL, DEDICATED_ACCOUNT_NOTE, isRootUser, ROOT_WARNING } from "../../packages/cli/src/init/prerequisites.js";
import { isOperatorStop } from "../../packages/cli/src/init/stop.js";
import { signedInAs } from "../../packages/cli/src/init/ui/cards.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import { HOLDER, scriptedPrompter } from "../support/init-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const home = async () => { const dir = await mkdtemp(join(tmpdir(), "agentx-aws-home-")); dirs.push(dir); await mkdir(join(dir, ".aws")); return dir; };
const expired = () => Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" });
const surface = () => { const cards: WizardCard[] = []; return { cards, card: (card: WizardCard) => { cards.push(card); } }; };
function runner(fail?: Error): CommandRunner & { runs: string[] } {
  const runs: string[] = [];
  return { runs, async run(command, args) { runs.push([command, ...args].join(" ")); if (fail !== undefined) throw fail; return { stdout: "" }; } };
}
const DEV: AwsProfile = { name: "dev", kind: "sso" };

describe("the AWS profiles on this machine", () => {
  it("lists every profile in config and credentials, default first, with how each signs in, and never a key", async () => {
    const dir = await home();
    await writeFile(join(dir, ".aws", "config"), [
      "[default]", "region = us-west-2", "",
      "[profile agentx-admin]", "login_session = arn:aws:iam::944937319445:user/owner", "region = us-east-1", "",
      "[profile dev]", "sso_session = acme", "sso_account_id = 111111111111", "sso_role_name = Admin", "",
      "[sso-session acme]", "sso_start_url = https://acme.awsapps.com/start", "",
      "[profile ci]", "role_arn = arn:aws:iam::222222222222:role/ci", "source_profile = default", "",
    ].join("\n"));
    await writeFile(join(dir, ".aws", "credentials"), [
      "[default]", "aws_access_key_id = AKIAEXAMPLEKEY", "aws_secret_access_key = SECRETexampleVALUE", "",
      "[legacy]", "aws_access_key_id = AKIAOTHERKEY", "aws_secret_access_key = SECRETotherVALUE",
    ].join("\n"));
    const profiles = await listAwsProfiles({ home: dir, processEnv: {} });
    expect(profiles).toEqual([
      { name: "default", kind: "keys", region: "us-west-2" },
      { name: "agentx-admin", kind: "login", region: "us-east-1" },
      { name: "ci", kind: "other" },
      { name: "dev", kind: "sso" },
      { name: "legacy", kind: "keys" },
    ]);
    const listed = JSON.stringify(profiles);
    for (const secret of ["AKIAEXAMPLEKEY", "SECRETexampleVALUE", "AKIAOTHERKEY", "SECRETotherVALUE"]) expect(listed).not.toContain(secret);
  });

  it("reads AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE when they are set, and finds nothing where there are no files", async () => {
    const dir = await home();
    await writeFile(join(dir, "elsewhere"), "[profile dev]\nsso_session = acme\n");
    expect(await listAwsProfiles({ home: dir, processEnv: { AWS_CONFIG_FILE: join(dir, "elsewhere"), AWS_SHARED_CREDENTIALS_FILE: join(dir, "none") } })).toEqual([DEV]);
    expect(await listAwsProfiles({ home: join(dir, "missing"), processEnv: {} })).toEqual([]);
  });

  it("reads sections and keys, ignoring comments and blank lines", () => {
    expect(parseAwsIni("# note\n[profile a]\n Region = eu-west-1 \n; other\n\n[b]\nx=1")).toEqual(new Map([
      ["profile a", new Map([["region", "eu-west-1"]])],
      ["b", new Map([["x", "1"]])],
    ]));
  });

  it("signs in to an IAM Identity Center profile with aws sso login, and an aws login profile with aws login", () => {
    expect(signInCommand(DEV)).toEqual({ command: "aws", args: ["sso", "login", "--profile", "dev"], display: "aws sso login --profile dev" });
    expect(signInCommand({ name: "agentx-admin", kind: "login" })).toEqual({ command: "aws", args: ["login", "--profile", "agentx-admin"], display: "aws login --profile agentx-admin" });
    expect(signInCommand({ name: "ci", kind: "other" })).toBeUndefined();
    expect(signInCommand({ name: "legacy", kind: "keys" })).toBeUndefined();
  });
});

describe("choosing the profile", () => {
  it("asks which of two or more, defaulting to AWS_PROFILE, and puts the answer in AWS_PROFILE", async () => {
    const processEnv: NodeJS.ProcessEnv = { AWS_PROFILE: "dev" };
    const prompter = scriptedPrompter([""]);
    const picked = await pickAwsProfile({ profiles: [{ name: "default", kind: "keys" }, DEV], processEnv, prompter });
    expect(picked).toEqual(DEV);
    expect(prompter.asked).toEqual(["AWS profile to install with"]);
    expect(processEnv.AWS_PROFILE).toBe("dev");
  });

  it("uses the only profile without asking", async () => {
    const processEnv: NodeJS.ProcessEnv = {};
    const prompter = scriptedPrompter([]);
    expect(await pickAwsProfile({ profiles: [DEV], processEnv, prompter })).toEqual(DEV);
    expect(processEnv.AWS_PROFILE).toBe("dev");
  });

  it("keeps an AWS_PROFILE it cannot list (a credential_process section, say) when it is the only one, without asking", async () => {
    const processEnv: NodeJS.ProcessEnv = { AWS_PROFILE: "vault" };
    const prompter = scriptedPrompter([]);
    expect(await pickAwsProfile({ profiles: [], processEnv, prompter })).toEqual({ name: "vault", kind: "other" });
    expect(prompter.asked).toEqual([]);
    expect(processEnv.AWS_PROFILE).toBe("vault");
  });

  it("offers an unlisted AWS_PROFILE beside the listed one, as the default, and never swaps it silently", async () => {
    const processEnv: NodeJS.ProcessEnv = { AWS_PROFILE: "vault" };
    const prompter = scriptedPrompter([""]);
    expect(await pickAwsProfile({ profiles: [DEV], processEnv, prompter })).toEqual({ name: "vault", kind: "other" });
    expect(prompter.asked).toEqual(["AWS profile to install with"]);
    expect(processEnv.AWS_PROFILE).toBe("vault");
  });

  it("asks nothing when keys are in the environment, which win over any profile", async () => {
    const processEnv: NodeJS.ProcessEnv = { AWS_ACCESS_KEY_ID: "AKIAENV" };
    expect(await pickAwsProfile({ profiles: [DEV, { name: "default", kind: "keys" }], processEnv, prompter: scriptedPrompter([]) })).toBeUndefined();
    expect(processEnv.AWS_PROFILE).toBeUndefined();
  });
});

describe("the account the install lands in", () => {
  it("shows the account, the role and the profile once AWS answers", async () => {
    const page = surface();
    const caller = await resolveCaller({ identity: () => ({ get: async () => ({ account: "123456789012", arn: HOLDER }) }), region: "us-east-1", prompter: scriptedPrompter([]), runner: runner(), surface: page, profile: DEV });
    expect(caller).toEqual({ account: "123456789012", arn: HOLDER });
    expect(page.cards).toEqual([{
      id: "aws", title: "AWS account", status: "ok",
      lines: [
        "AgentX installs into AWS account 123456789012 in us-east-1.",
        `You are signed in as ${signedInAs(HOLDER)}, with the AWS profile dev.`,
        "Tip: a separate AWS account just for AgentX keeps its costs and permissions apart from your other work.",
      ],
      details: [HOLDER],
    }]);
  });

  it("without a page, an expired session fails exactly as before and runs nothing", async () => {
    const failure = expired();
    const commands = runner();
    await expect(resolveCaller({ identity: () => ({ get: async () => { throw failure; } }), region: "us-east-1", prompter: scriptedPrompter([]), runner: commands, profile: DEV })).rejects.toBe(failure);
    expect(commands.runs).toEqual([]);
  });

  it("on the page, offers the profile's sign-in, runs it, and asks AWS again with a new client", async () => {
    const page = surface();
    const commands = runner();
    let clients = 0;
    const caller = await resolveCaller({
      identity: () => { clients += 1; const mine = clients; return { get: async () => { if (mine === 1) throw expired(); return { account: "123456789012", arn: HOLDER }; } }; },
      region: "us-east-1", prompter: scriptedPrompter(["signin"]), runner: commands, surface: page, profile: DEV,
    });
    expect(caller.account).toBe("123456789012");
    expect(commands.runs).toEqual(["aws sso login --profile dev"]);
    expect(clients).toBe(2);
    expect(page.cards.map((card) => card.status)).toEqual(["failed", "ok"]);
    expect(page.cards[0]?.lines).toEqual([
      "The AWS sign-in of the profile dev is missing or has ended.",
      "Choose Sign in again. A browser tab opens for the AWS sign-in; finish it there, then come back to this tab.",
    ]);
  });

  it("shows a sign-in that could not run and asks again; Stop ends the run with the credentials error", async () => {
    const page = surface();
    const failure = expired();
    const prompter = scriptedPrompter(["signin", "stop"]);
    await expect(resolveCaller({
      identity: () => ({ get: async () => { throw failure; } }), region: "us-east-1", prompter,
      runner: runner(Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT" })), surface: page, profile: DEV,
    })).rejects.toBe(failure);
    expect(prompter.asked).toEqual(["Your AWS sign-in is missing or has expired. What next?", "Your AWS sign-in is missing or has expired. What next?"]);
    expect(page.cards.at(-1)?.details).toContain("could not run aws sso login --profile dev: spawn aws ENOENT");
  });

  it("names a sign-in that could not start in one line, without the command twice or a stderr tail", async () => {
    const page = surface();
    const prompter = scriptedPrompter(["signin", "signin", "stop"]);
    let runs = 0;
    const failing: CommandRunner = {
      async run() {
        runs += 1;
        throw new Error(runs === 1
          ? "aws sso login --profile dev could not start: spawn aws ENOENT"
          : "aws sso login --profile dev exited with code 255:\nError when retrieving token from sso: Token has expired and refresh failed\nsecond line");
      },
    };
    await expect(resolveCaller({ identity: () => ({ get: async () => { throw expired(); } }), region: "us-east-1", prompter, runner: failing, surface: page, profile: DEV })).rejects.toThrow("expired");
    const problems = page.cards.map((card) => card.details?.[2]);
    expect(problems[1]).toBe("aws sso login --profile dev could not start: spawn aws ENOENT");
    expect(problems[2]).toBe("aws sso login --profile dev exited with code 255");
    for (const card of page.cards) for (const line of card.lines) expect(line).not.toContain("\n");
  });

  it("offers only check again for a profile AgentX cannot sign in to, and rethrows anything that is not a sign-in problem", async () => {
    const page = surface();
    let calls = 0;
    const caller = await resolveCaller({
      identity: () => ({ get: async () => { calls += 1; if (calls === 1) throw expired(); return { account: "123456789012", arn: HOLDER }; } }),
      region: "us-east-1", prompter: scriptedPrompter(["retry"]), runner: runner(), surface: page, profile: { name: "legacy", kind: "keys" },
    });
    expect(caller.account).toBe("123456789012");
    expect(page.cards[0]?.lines.at(-1)).toBe("Sign in to AWS again another way, then choose I signed in another way, check again.");

    const denied = Object.assign(new Error("not authorized to perform sts:GetCallerIdentity"), { name: "AccessDeniedException" });
    await expect(resolveCaller({ identity: () => ({ get: async () => { throw denied; } }), region: "us-east-1", prompter: scriptedPrompter([]), runner: runner(), surface: surface(), profile: DEV })).rejects.toBe(denied);
  });

  it("FR-016: warns a root user on the page, links to making an admin user, and continuing works", async () => {
    const page = surface();
    const root = "arn:aws:iam::123456789012:root";
    const prompter = scriptedPrompter([""]);
    const caller = await resolveCaller({ identity: () => ({ get: async () => ({ account: "123456789012", arn: root }) }), region: "us-east-1", prompter, runner: runner(), surface: page });
    expect(caller).toEqual({ account: "123456789012", arn: root });
    expect(prompter.asked).toEqual(["You are signed in as the AWS root user. Continue?"]);
    expect(page.cards[0]).toMatchObject({
      id: "aws", status: "waiting",
      lines: [
        "AgentX installs into AWS account 123456789012 in us-east-1.",
        "You are signed in as the AWS root user. AgentX works, but AWS advises an admin user instead.",
        "You can continue as root. A few day-two commands need an admin user instead; the ready screen says which.",
      ],
      link: { url: ADMIN_USER_GUIDE_URL, label: "How to create an admin user" },
      details: [root],
    });
    expect(page.cards[1]).toMatchObject({ id: "aws", status: "ok" });
  });

  it("FR-016: stopping at the root warning is the person's own stop, not a failure", async () => {
    const error = await resolveCaller({ identity: () => ({ get: async () => ({ account: "123456789012", arn: "arn:aws:iam::123456789012:root" }) }), region: "us-east-1", prompter: scriptedPrompter(["stop"]), runner: runner(), surface: surface() }).catch((caught: unknown) => caught);
    expect(isOperatorStop(error)).toBe(true);
  });

  it("FR-016: without a page, a root user gets the warning as a line and no question", async () => {
    const lines: string[] = [];
    const prompter = scriptedPrompter([]);
    await resolveCaller({ identity: () => ({ get: async () => ({ account: "123456789012", arn: "arn:aws:iam::123456789012:root" }) }), region: "us-east-1", prompter, runner: runner(), write: (line) => lines.push(line) });
    expect(lines).toEqual([ROOT_WARNING]);
    expect(prompter.asked).toEqual([]);
  });

  it("FR-017: the account tip is plain words with no double negative", () => {
    expect(DEDICATED_ACCOUNT_NOTE).toBe("Tip: a separate AWS account just for AgentX keeps its costs and permissions apart from your other work.");
    expect(DEDICATED_ACCOUNT_NOTE).not.toMatch(/\bnot\b|\bno\b|\bnever\b/);
  });

  it("knows the root user from its ARN only", () => {
    expect(isRootUser("arn:aws:iam::123456789012:root")).toBe(true);
    expect(isRootUser("arn:aws-us-gov:iam::123456789012:root")).toBe(true);
    expect(isRootUser("arn:aws:sts::123456789012:assumed-role/root/alice")).toBe(false);
  });
});
