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
    const positions = order.map((text) => guide.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(guide).toContain("https://github.com/PrepLabsAI/AgentX/issues/66");
  });

  it("has an install guide for each path, and a move guide that links #67", () => {
    const install = read("docs/install.md");
    for (const heading of ["## With published templates (recommended)", "## With cdk", "## Through your platform team (export)"]) expect(install).toContain(heading);
    expect(read("docs/move-account.md")).toContain("https://github.com/PrepLabsAI/AgentX/issues/67");
  });

  it("uses no em dash in any guide", () => {
    for (const path of ["docs/install.md", "docs/day-two.md", "docs/teardown.md", "docs/move-account.md"]) expect(read(path), path).not.toContain("—");
  });
});
