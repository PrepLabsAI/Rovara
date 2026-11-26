import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { companyRouteHarness, TASK, PERSON, TIME } from "../support/company-route-harness.js";

export const GOLDEN_CASES = ["task-found", "task-missing", "empty-list", "paged-list", "project-grant", "project-channel", "project-none"] as const;

// D1-2 (DEC 254zzz502): the harness's tasks carry the core's mark (only a marked task is listed), and a core task's row is listed as its index row says, so the `stale-updatedAt` golden of the checked mode
// now shows the index row's own updatedAt (12:00); the retired workflow list recomputed it from the task view (13:00). The other five goldens are unchanged.
it.each(["project", "status", "stale-updatedAt"] as const)("filtered implicit-company golden: %s", async (filter) => {
  for (const enabled of [false, true]) {
    const h = companyRouteHarness();
    if (enabled) h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
    // A real member of the project holds a grant on it; the person's own list shows a task only while they do (project-grant re-check).
    h.project();
    const task = h.task();
    const newest = h.task("22222222-2222-4222-8222-222222222222");
    const key = { pk: `DEVELOPER#${PERSON}`, sk: `TASK#${TIME}#${newest.taskId}` };
    if (filter === "project") {
      h.db.set({ ...newest, project: "other-project" });
      h.db.set({ ...h.db.get(key.pk, key.sk)!, project: "other-project" });
    } else if (filter === "status") {
      h.db.set({ ...newest, closedAt: TIME });
      h.db.set({ ...h.db.get(key.pk, key.sk)!, status: "CLOSED" });
    } else {
      h.db.set({ ...task, updatedAt: "2026-11-14T13:00:00.000Z" });
      h.db.set({ ...newest, updatedAt: "2026-11-14T13:00:00.000Z" });
      // Keep the status already current so only the index timestamp is stale.
      for (const id of [TASK, newest.taskId]) {
        const sk = `TASK#${TIME}#${id}`;
        h.db.set({ ...h.db.get(key.pk, sk)!, status: "STARTING" });
      }
    }
    const query = filter === "status" ? "status=STARTING" : "project=shared-project";
    const actual = JSON.stringify(await h.read(`/v1/dev/tasks?limit=1&${query}`));
    const file = `tests/fixtures/company-check-goldens/filtered-${filter}-${enabled ? "checked" : "legacy"}.json`;
    expect(actual).toBe(readFileSync(file, "utf8").trimEnd());
  }
});
