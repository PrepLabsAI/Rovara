// Port lane L11 (L5): a credentialed git command refuses redirects, and its askpass helper answers only for github.com and the host of the address the command was given.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGitWithCredential, type CredentialedGitRunner } from "../../packages/worker/src/git-auth.js";
import { HARDENED_GIT_CONFIG } from "../../packages/worker/src/git.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

async function askpassAnswers(args: string[], prompts: string[]): Promise<Array<string | undefined>> {
  const directory = await mkdtemp(join(tmpdir(), "rovara-l11-askpass-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", directory]);
  const answers: Array<string | undefined> = [];
  const run: CredentialedGitRunner = async (_args, options) => {
    for (const prompt of prompts) {
      try {
        answers.push(execFileSync(options.env.GIT_ASKPASS!, [prompt], { env: options.env, encoding: "utf8" }).trim());
      } catch {
        answers.push(undefined);
      }
    }
    return { stdout: "", stderr: "" };
  };
  await runGitWithCredential({ directory, args, credential: { username: "x-access-token", password: "pw-for-the-test" }, run });
  return answers;
}

describe("the worker's credentialed git (L5)", () => {
  it("never follows a redirect", () => {
    expect(HARDENED_GIT_CONFIG).toContainEqual(["http.followRedirects", "false"]);
  });

  it("answers the username and password prompts for github.com, and for nothing else", async () => {
    const answers = await askpassAnswers(["clone", "https://github.com/acme/app.git", "dest"], [
      "Username for 'https://github.com': ",
      "Password for 'https://x-access-token@github.com': ",
      "Password for 'https://github.com.attacker.example': ",
      "Password for 'https://x-access-token@evil.example': ",
      "Password for 'https://x-access-token@notgithub.com': ",
      "Something else: ",
    ]);
    expect(answers).toEqual(["x-access-token", "pw-for-the-test", undefined, undefined, undefined, undefined]);
  });

  it("also answers for the host of an https address it was given, and not before", async () => {
    const answers = await askpassAnswers(["fetch", "https://git.examplehost.test/team/app.git"], [
      "Password for 'https://x-access-token@git.examplehost.test': ",
      "Password for 'https://x-access-token@elsewhere.test': ",
    ]);
    expect(answers).toEqual(["pw-for-the-test", undefined]);
  });
});
