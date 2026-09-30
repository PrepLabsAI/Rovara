// tests/contract/init-aws-account.test.ts
// FR-020 and FR-021 (Q9): the AWS screen lists this machine's profiles, shows the account the
// install lands in, and signs in again when the session has expired, instead of ending the run.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listAwsProfiles, parseAwsIni, pickAwsProfile, resolveCaller, signInCommand, type AwsProfile } from "../../packages/cli/src/init/aws-account.js";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
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
        "AgentX installs into account 123456789012 in us-east-1.",
        `Signed in as ${HOLDER} (profile dev).`,
        "AgentX recommends a dedicated AWS account for each install: environments that share an account are not a security boundary against each other.",
      ],
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
      "AgentX cannot use the AWS sign-in of profile dev.",
      "AWS credentials missing or expired: The security token included in the request is expired",
      "Choose Sign in to run aws sso login --profile dev; a browser tab opens for it.",
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
    expect(page.cards.at(-1)?.lines).toContain("could not run aws sso login --profile dev: spawn aws ENOENT");
  });

  it("offers only check again for a profile AgentX cannot sign in to, and rethrows anything that is not a sign-in problem", async () => {
    const page = surface();
    let calls = 0;
    const caller = await resolveCaller({
      identity: () => ({ get: async () => { calls += 1; if (calls === 1) throw expired(); return { account: "123456789012", arn: HOLDER }; } }),
      region: "us-east-1", prompter: scriptedPrompter(["retry"]), runner: runner(), surface: page, profile: { name: "legacy", kind: "keys" },
    });
    expect(caller.account).toBe("123456789012");
    expect(page.cards[0]?.lines.at(-1)).toBe("Update the credentials of profile legacy in a terminal, then choose Check again.");

    const denied = Object.assign(new Error("not authorized to perform sts:GetCallerIdentity"), { name: "AccessDeniedException" });
    await expect(resolveCaller({ identity: () => ({ get: async () => { throw denied; } }), region: "us-east-1", prompter: scriptedPrompter([]), runner: runner(), surface: surface(), profile: DEV })).rejects.toBe(denied);
  });
});
