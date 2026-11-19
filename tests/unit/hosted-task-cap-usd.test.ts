// L4-TA6: `hostedTaskCapUsd` is the cap automatic fixing is held to on a hosted install: the very value Admission enforces (`taskCapOf`), in dollars, read fresh for one company's task.
import { describe, expect, it } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { hostedTaskCapUsd, taskCapOf, type HostedAdmissionSettings } from "../../packages/broker/src/core-host/hosted-modules.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createFakeWorld } from "../support/core-host-fakes.js";

const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const TASK = "33333333-3333-4333-8333-333333333333";
const settings = (taskCapMicros: number): HostedAdmissionSettings => ({ allowedCompanies: "all", taskCapMicros, companyDayCapMicros: 25_000_000 });

async function seeded(project = "demo") {
  const w = createFakeWorld();
  await w.store.put({ item: { ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, companyId: A, workspaceId: "ws", project } });
  return w;
}
const task = (companyId: string = A, project = "demo") => ({ companyId, taskId: TASK, project });

describe("hostedTaskCapUsd (L4-TA6)", () => {
  it("is the install's task cap in dollars, the same figure Admission's own cap reads (taskCapOf)", async () => {
    const w = await seeded();
    for (const micros of [1_000_000, 5_000_000, 50_000_000]) {
      const cap = await hostedTaskCapUsd({ store: w.store, companyId: A, settings: settings(micros) })(task());
      expect(cap).toBe(micros / 1_000_000);
      expect(cap).toBe((await taskCapOf({ store: w.store, settings: settings(micros) }, A, TASK, "demo")).micros / 1_000_000);
    }
  });

  it("the project's own lower limit lowers it, read on every call; a higher one never raises it; an unreadable one throws", async () => {
    const w = await seeded();
    let limit: number | undefined = 400_000;
    const read = hostedTaskCapUsd({ store: w.store, companyId: A, settings: settings(5_000_000), projectTaskCap: async () => limit });
    expect(await read(task())).toBe(0.4);
    limit = 2_000_000;
    expect(await read(task())).toBe(2);
    limit = 900_000_000;
    expect(await read(task())).toBe(5);
    limit = undefined;
    expect(await read(task())).toBe(5);
    limit = -1;
    await expect(read(task())).rejects.toThrow();
    await expect(hostedTaskCapUsd({ store: w.store, companyId: A, settings: settings(5_000_000), projectTaskCap: async () => { throw new Error("rules service down"); } })(task())).rejects.toThrow();
  });

  it("unknown is a throw, never a figure: no caps on the install, a task of another company, a task whose record names another project, a task id with no record", async () => {
    const w = await seeded();
    await expect(hostedTaskCapUsd({ store: w.store, companyId: A, settings: undefined })(task())).rejects.toThrow();
    await expect(hostedTaskCapUsd({ store: w.store, companyId: B, settings: settings(1_000_000) })(task(A))).rejects.toThrow();
    await expect(hostedTaskCapUsd({ store: w.store, companyId: A, settings: settings(1_000_000), projectTaskCap: async () => undefined })(task(A, "other-project"))).rejects.toThrow();
    // a stored task that belongs to another company, asked for through this company's reader
    await w.store.put({ item: { ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, companyId: B, workspaceId: "ws", project: "demo" } });
    await expect(hostedTaskCapUsd({ store: w.store, companyId: A, settings: settings(1_000_000), projectTaskCap: async () => undefined })(task(A))).rejects.toThrow();
  });

  it("two companies with the same project name each get their own project's limit", async () => {
    const w = await seeded();
    await w.store.put({ item: { ...taskKey("66666666-6666-4666-8666-666666666666"), entityType: "DEVELOPER_TASK", taskId: "66666666-6666-4666-8666-666666666666", companyId: B, workspaceId: "ws-b", project: "demo" } });
    const limits: Record<string, number> = { [A]: 1_000_000, [B]: 4_000_000 };
    const projectTaskCap = async (companyId: string) => limits[companyId];
    expect(await hostedTaskCapUsd({ store: w.store, companyId: A, settings: settings(5_000_000), projectTaskCap })(task(A))).toBe(1);
    expect(await hostedTaskCapUsd({ store: w.store, companyId: B, settings: settings(5_000_000), projectTaskCap })({ companyId: B, taskId: "66666666-6666-4666-8666-666666666666", project: "demo" })).toBe(4);
  });
});
