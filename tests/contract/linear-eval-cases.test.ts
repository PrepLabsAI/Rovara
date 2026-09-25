// Phase 4 owns the runner (npm run eval). Until it lands, this checks the Linear cases are well
// formed against contracts/evaluation.md and name tools their project would present.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { z } from "zod";
import { ProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { ORCHESTRATION_TOOL_NAMES } from "../../packages/orchestrator/src/orchestration-tools.js";

const CaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  project: z.string().regex(/^fixtures\/[a-z0-9-]+\.yaml$/),
  prompt: z.string().min(1).max(2_000),
  expect: z.object({ tool: z.string().nullable(), argsSubset: z.record(z.string(), z.unknown()).optional(), refusal: z.string().optional() }).strict(),
}).strict();

const root = new URL("../eval/", import.meta.url);
const cases = readFileSync(new URL("cases/linear.jsonl", root), "utf8").split("\n").filter((line) => line.trim()).map((line) => CaseSchema.parse(JSON.parse(line)));

describe("Linear evaluation cases", () => {
  it("has unique ids and at least one read, write, comment, not-connected and cross-vendor case", () => {
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    for (const tool of ["linear__list_issues", "linear__save_issue", "linear__save_comment", "linear__get_issue", "github__list_issues", "agentx_submit_task", null]) {
      expect(cases.some((entry) => entry.expect.tool === tool)).toBe(true);
    }
  });

  it.each(cases.map((entry) => [entry.id, entry] as const))("%s names a parsing project and a tool it presents", (_id, entry) => {
    const file = new URL(entry.project, root);
    expect(existsSync(file)).toBe(true);
    const project = ProjectDefinitionSchema.parse(YAML.parse(readFileSync(file, "utf8")));
    const presented = new Set<string>([...ORCHESTRATION_TOOL_NAMES, ...(project.integrations?.connectors ?? []).flatMap((connector) => connector.tools.map((tool) => `${connector.name}__${tool.name}`))]);
    if (entry.expect.tool === null) expect(entry.expect.refusal).toBeDefined();
    else expect(presented.has(entry.expect.tool)).toBe(true);
  });
});
