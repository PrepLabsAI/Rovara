// Naming phase 1: text that the CLI writes and later reads back (a project file's register line) or strips from
// older messages (the closing "run <command> init again") must work for BOTH command names, so files and logs
// from before the rename keep working.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentProjectFiles } from "../../packages/cli/src/setup/project-add.js";
import { onPageProblem } from "../../packages/cli/src/init/ui/cards.js";
import { plainReason } from "../../packages/cli/src/init/ui/failure.js";

const header = (command: string) => [
  `# Registered by ${command}. It holds no secret, only credential references.`,
  "# To change the project, edit this file and raise revision, then register it yourself:",
  `#   ${command} admin project register --env staging --file /x/p.yaml --deployment-mode ec2-ebs --launch-template-id lt-0123456789abcdef0 --subnets us-east-1a=subnet-0aaa1111bbbb2222c`,
  "",
].join("\n");

describe("project files written before and after the rename", () => {
  it("are both found by the register line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rovara-legacy-readers-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "old.yaml"), `${header("agentx")}name: old\nrevision: 1\n`);
    await writeFile(join(dir, "new.yaml"), `${header("rovara")}name: new\nrevision: 1\n`);
    await writeFile(join(dir, "other.yaml"), `${header("npx")}name: other\nrevision: 1\n`);
    const found = await environmentProjectFiles(dir, "staging");
    expect(found.map((file) => [file.name, file.launchTemplateId])).toEqual([["new", "lt-0123456789abcdef0"], ["old", "lt-0123456789abcdef0"]]);
  });
});

describe("the closing 'run <command> init again' of a step's message", () => {
  it.each(["agentx", "rovara"])("is dropped from a card's problem for %s, with and without --env", (command) => {
    expect(onPageProblem(`the bot was not invited; run ${command} init again`)).toBe("the bot was not invited");
    expect(onPageProblem(`the bot was not invited, then run ${command} --env staging init again.`)).toBe("the bot was not invited");
  });

  it.each(["agentx", "rovara"])("and the resume tail is dropped from the plain reason for %s", (command) => {
    const error = new Error(`init stopped at "Slack": Slack did not answer. Run ${command} init --env staging --region us-east-1 again to continue from this step.`);
    expect(plainReason(error)).toBe("Slack did not answer.");
  });
});
