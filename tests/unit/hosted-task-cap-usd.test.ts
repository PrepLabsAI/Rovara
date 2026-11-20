// L4-TA6: `hostedTaskCapUsd` is the cap automatic fixing is held to on a hosted install: the very value Admission enforces (`taskCapOf`), in dollars, read fresh for one company's task.
import { describe, expect, it } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { hostedTaskCapUsd, type HostedAdmissionSettings } from "../../packages/broker/src/core-host/hosted-modules.js";
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
});
