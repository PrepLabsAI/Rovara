import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { companyRouteHarness, TASK } from "../support/company-route-harness.js";

export const GOLDEN_CASES = ["task-found", "task-missing", "empty-list", "paged-list", "project-grant", "project-channel", "project-none"] as const;
it.each(GOLDEN_CASES.flatMap((name) => [false, true].map((enabled) => ({ name, enabled }))))("unchanged base bytes: $name, check=$enabled", async ({ name, enabled }) => {
  const h = companyRouteHarness();
  if (enabled) h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
  let path: string = `/v1/dev/tasks/${TASK}`;
  if (name === "task-found") h.task();
  if (name === "empty-list" || name === "paged-list") {
    path = "/v1/dev/tasks?limit=1";
    if (name === "paged-list") { h.task(); h.task("22222222-2222-4222-8222-222222222222"); }
  }
  if (name.startsWith("project-")) {
    path = "/v1/dev/projects";
    h.project(undefined, name === "project-grant" ? "grant" : name === "project-channel" ? "channel" : "none");
  }
  const result = JSON.stringify(await h.read(path));
  const file = `tests/fixtures/company-check-goldens/${name}.json`;
  expect(result).toBe(readFileSync(file, "utf8").trimEnd());
});
