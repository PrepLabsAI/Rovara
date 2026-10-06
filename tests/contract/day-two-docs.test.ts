// FR-054's guides stay true to the code: every config key is in the day-2 guide's table with the
// place it maps to, and the teardown guide gives destroy's order and the worker tag guard.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../../packages/cli/src/config/keys.js";

const read = (path: string) => readFileSync(path, "utf8");

describe("the guides (FR-054)", () => {
  it("lists every config key in the day-2 guide, on one table row with where it lives", () => {
    const rows = read("docs/day-two.md").split("\n").filter((line) => line.startsWith("| `"));
    for (const entry of CONFIG_KEYS) {
      const row = rows.find((line) => line.startsWith(`| \`${entry.key}\` |`));
      expect(row, entry.key).toBeDefined();
      const place = entry.target.kind === "stack-parameter" ? entry.target.parameter : entry.target.kind === "settings" ? "alertAddress" : `WORKSPACE_LIMITS.${entry.target.field}`;
      expect(row, entry.key).toContain(place);
    }
  });

  it("gives the teardown order, the three worker tags, and agentx destroy", () => {
    const guide = read("docs/teardown.md");
    expect(guide).toContain("agentx --env <env> destroy --region <region>");
    expect(guide).toContain("Name=tag:agentx:env,Values=<env>");
    const order = ["agentx-<env>-slack", "agentx-<env>-runtime", "agentx-<env>-control-plane", "aws ec2 terminate-instances", "agentx-<env>-identity", "agentx-<env>-foundation", "agentx-<env>-access"];
    // The order is checked in the by-hand steps, so the agentx destroy section may name every stack.
    const byHand = guide.slice(guide.indexOf("## By hand"));
    expect(guide.indexOf("## By hand")).toBeGreaterThan(0);
    const positions = order.map((text) => byHand.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(guide).toContain("https://github.com/PrepLabsAI/Rovara/issues/66");
  });

  it("has an install guide for each path, and a move guide that links #67", () => {
    const install = read("docs/install.md");
    for (const heading of ["## With published templates (recommended)", "## With cdk", "## Through your platform team (export)"]) expect(install).toContain(heading);
    expect(read("docs/move-account.md")).toContain("https://github.com/PrepLabsAI/Rovara/issues/67");
  });

  it("tells the release test owner that each ECR repository needs a lifecycle policy for the rt- images (final review M3)", () => {
    const guide = read("docs/releases.md");
    const step3 = guide.slice(guide.indexOf("3. **Two private ECR repositories**"), guide.indexOf("4. **A test GitHub App**"));
    expect(step3).toContain("Each repository needs a lifecycle policy that expires `rt-*` images");
  });

  it("says destroy never takes a lock over without a terminal (final review M11)", () => {
    expect(read("docs/teardown.md")).toContain("It asks only at a terminal: without one (answers piped on stdin), it\nnever takes a lock over");
  });

  it("has the section the refused-bot-token fix names, with the console steps and doctor (live check L1)", () => {
    const guide = read("docs/day-two.md");
    const start = guide.indexOf("## Replace the Slack bot token");
    expect(start).toBeGreaterThan(0);
    const section = guide.slice(start, guide.indexOf("\n## ", start + 1));
    for (const step of ["**Secrets Manager**", "`agentx/<env>/slack`", "**Retrieve secret value**", "**Edit**", "Change only the value of the `botToken` key", "**Save**", "agentx --env <env> doctor"]) expect(section, step).toContain(step);
    expect(section).toContain("within 5 minutes of the\nsave");
  });

  it("uses no em dash in any guide", () => {
    for (const path of ["docs/install.md", "docs/day-two.md", "docs/teardown.md", "docs/move-account.md"]) expect(read(path), path).not.toContain("\u2014");
  });
});
