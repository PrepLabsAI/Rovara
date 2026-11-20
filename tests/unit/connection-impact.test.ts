import { describe, expect, it } from "vitest";
import { serverReadWorld, READ_COMPANY, READ_OTHER, READ_PERSON } from "../support/server-read-world.js";

const path = "/v1/dev/company/connections/impact";
const body = { provider: "github", operation: "disconnect", target: { installationId: 7 } };
describe("local disconnect policy preview at the deployed broker", () => {
  it("returns only local policy blockers, no transport ID or dependency claims, with no mutations", async () => {
    const w = await serverReadWorld(); w.addInstallation();
    const r = await w.impact(); expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...body, checkedAt: expect.any(String) as unknown, snapshot: "non_atomic", disconnectBlockers: { kind: "exact", count: 1, projects: ["payments"] }, repositories: { kind: "unknown", reason: "not_projected" }, runningTasks: { kind: "unknown", reason: "not_projected" }, queuedTasks: { kind: "unknown", reason: "not_projected" } });
    expect(r.headers["cache-control"]).toContain("no-store");
    expect(w.send.mock.calls.every(([cmd]) => ["GetCommand", "QueryCommand"].includes(cmd.constructor.name))).toBe(true);
  });
  it.each([{}, { ...body, extra: true }, { ...body, target: { installationId: 0 } }, { ...body, target: { installationId: 7, actor: "other" } }, { ...body, provider: "slack" }])("rejects invalid input %j", async (input) => {
    const w = await serverReadWorld(); expect((await w.call("POST", path, input)).status).toBe(400);
  });
  it.each(["owner", "website"])("checks live %s before installation/catalog facts", async (kind) => {
    const w = await serverReadWorld(); w.addInstallation();
    if (kind === "owner") w.setMember(READ_PERSON, READ_COMPANY, "admin");
    else { const row = { ...w.db.get("SIGNIN_CLIENTS", "CLIENT#read-web") }; delete row.webApp; w.db.set(row); }
    const r = await w.impact(); expect(r.status).toBe(403);
    expect(w.send.mock.calls.some(([c]) => JSON.stringify(c.input).includes("GITHUB_INSTALLATIONS"))).toBe(false);
  });
  it.each(["absent", "foreign"])("masks a proven %s installation", async (kind) => {
    const w = await serverReadWorld(); if (kind === "foreign") w.addInstallation(7, { companyId: READ_OTHER });
    expect((await w.impact()).status).toBe(404);
  });
  it.each([0, 1])("rejects a continued inventory with %i rows, without following or joining", async (count) => {
    const w = await serverReadWorld(); w.addInstallation(); const original = w.rawSend;
    w.send.mockImplementation(async (command) => {
      const result = await original(command) as { Items?: unknown[] };
      if (JSON.stringify(command.input).includes("GITHUB_INSTALLATIONS")) return { Items: (result.Items ?? []).slice(0, count), LastEvaluatedKey: { pk: "continued", sk: "later" } };
      return result;
    });
    const r = await w.impact(); expect(r.status).toBe(503);
    expect(w.send.mock.calls.some(([c]) => JSON.stringify(c.input).includes("PROJECT_CATALOG"))).toBe(false);
  });
  it.each([100, 101])("requires a complete <=100-row inventory (%i)", async (count) => {
    const w = await serverReadWorld(); for (let n = 1; n <= count; n++) w.addInstallation(n);
    expect((await w.impact()).status).toBe(count === 100 ? 200 : 503);
  });
  it("discards a join on final binding drift", async () => {
    const w = await serverReadWorld(); w.addInstallation(); const original = w.rawSend; let reads = 0;
    w.send.mockImplementation(async (command) => {
      if ((command.input as { Key?: { pk?: string } }).Key?.pk === "GITHUB_INSTALLATION#7" && ++reads === 2) w.addInstallation(7, { accountLogin: "changed" });
      return original(command);
    });
    const r = await w.impact(); expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("disconnectBlockers");
  });
  it("discards names after final owner loss", async () => {
    const w = await serverReadWorld(); w.addInstallation(); const original = w.rawSend;
    w.send.mockImplementation(async (command) => {
      const result = await original(command);
      if (JSON.stringify(command.input).includes("PROJECT_CATALOG")) w.setMember(READ_PERSON, READ_COMPANY, "admin");
      return result;
    });
    const r = await w.impact(); expect(r.status).toBe(403); expect(r.body).not.toHaveProperty("disconnectBlockers");
  });
});

describe("preview inventory and join limits", () => {
  it.each(["duplicate", "malformed", "cursor"])("refuses %s inventory without a partial list", async (kind) => {
    const w = await serverReadWorld(); w.addInstallation();
    w.send.mockImplementation(async command => {
      const result = await w.rawSend(command) as { Items?: unknown[] };
      if (JSON.stringify(command.input).includes("GITHUB_INSTALLATIONS")) {
        if (kind === "duplicate") return { Items: [result.Items![0], result.Items![0]] };
        if (kind === "cursor") return { Items: result.Items, LastEvaluatedKey: "bad" };
        return { Items: [{ ...result.Items![0] as object, companyId: READ_OTHER }] };
      }
      return result;
    });
    const r = await w.impact(); expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("disconnectBlockers");
  });
  it("uses case-insensitive active alternate accounts for unpinned policy", async () => {
    const w = await serverReadWorld(); w.addInstallation(); w.addInstallation(8, { accountLogin: "EXAMPLE" });
    const key = `ORG#${READ_COMPANY}#PROJECT#payments`;
    const revision = w.db.get(key, "REV#000000000001")!;
    const definition = revision.definition as Record<string, unknown>;
    w.db.set({ ...revision, definition: { ...definition, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] } });
    const r = await w.impact(); expect(r.status).toBe(200); expect(r.body.disconnectBlockers).toEqual({ kind: "exact", count: 0, projects: [] });
    w.addInstallation(8, { accountLogin: "EXAMPLE", state: "suspended" });
    expect((await w.impact()).body.disconnectBlockers).toEqual({ kind: "exact", count: 1, projects: ["payments"] });
  });
  it.each([400, 401])("examines all %i catalog rows and never emits partial exact/zero", async (count) => {
    const w = await serverReadWorld(); w.addInstallation();
    let pages = 0;
    w.send.mockImplementation(async command => {
      const input = command.input as { Key?: { pk?: string }; ExpressionAttributeValues?: Record<string, string> };
      if (command.constructor.name === "QueryCommand" && input.ExpressionAttributeValues?.[":pk"] === `ORG#${READ_COMPANY}#PROJECT_CATALOG`) {
        const from = pages++ * 100; const end = Math.min(count, from + 100);
        return { Items: Array.from({ length: end - from }, (_, i) => ({ pk: `ORG#${READ_COMPANY}#PROJECT_CATALOG`, sk: `PROJECT#p${String(from + i).padStart(3, "0")}` })), ...(end === count ? {} : { LastEvaluatedKey: { pk: `ORG#${READ_COMPANY}#PROJECT_CATALOG`, sk: `PROJECT#p${String(end - 1).padStart(3, "0")}` } }) };
      }
      return w.rawSend(command);
    });
    const r = await w.impact();
    if (count === 401) { expect(r.status).toBe(200); expect(r.body.disconnectBlockers).toEqual({ kind: "unknown", reason: "read_bound" }); }
    else { expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("disconnectBlockers"); }
  });
  it("returns unknown/read_unavailable on a join transport failure only after final authority", async () => {
    const w = await serverReadWorld(); w.addInstallation();
    w.send.mockImplementation(async command => { if (JSON.stringify(command.input).includes("PROJECT_CATALOG") && command.constructor.name === "QueryCommand") throw new Error("private SDK text"); return w.rawSend(command); });
    const r = await w.impact(); expect(r.status).toBe(200); expect(r.body.disconnectBlockers).toEqual({ kind: "unknown", reason: "read_unavailable" });
    expect(JSON.stringify(r.body)).not.toContain("private SDK text");
  });
  it("keeps one binding sub-budget across initial snapshot and final target reread", async () => {
    const { companyInstallationSnapshotReader } = await import("../../packages/broker/src/aws/github-credentials.js");
    const w = await serverReadWorld(); w.addInstallation();
    const reader = companyInstallationSnapshotReader({ send: command => w.rawSend(command as never) }, "state");
    await reader.readComplete(READ_COMPANY);
    for (let i = 0; i < 302; i++) await reader.rereadTarget(READ_COMPANY, 7);
    await expect(reader.rereadTarget(READ_COMPANY, 7)).rejects.toThrow();
  });
});

// Final caller authority must follow the last domain await.
it("discards preview facts when owner access is lost during the final binding read", async () => {
  const w = await serverReadWorld(); w.addInstallation(); let reads = 0;
  w.send.mockImplementation(async command => {
    const result = await w.rawSend(command);
    if ((command.input.Key as { pk?: string } | undefined)?.pk === "GITHUB_INSTALLATION#7" && ++reads === 2) w.setMember(READ_PERSON, READ_COMPANY, "admin");
    return result;
  });
  const result = await w.impact();
  expect(result.status).toBe(403); expect(result.body).not.toHaveProperty("disconnectBlockers");
});


it.each(["empty-name", "extra-key", "backward"])("rejects a malformed %s catalog continuation without emitting exact zero", async kind => {
  const w = await serverReadWorld(); w.addInstallation(); let pages = 0;
  w.send.mockImplementation(async command => {
    const values = command.input.ExpressionAttributeValues as Record<string, unknown> | undefined;
    if (String(values?.[":pk"]).includes("PROJECT_CATALOG")) {
      pages += 1;
      const pk = values![":pk"];
      if (kind === "empty-name" && pages === 1) return { Items: [], LastEvaluatedKey: { pk, sk: "PROJECT#" } };
      if (kind === "extra-key" && pages === 1) return { Items: [], LastEvaluatedKey: { pk, sk: "PROJECT#payments", extra: "invalid" } };
      if (kind === "backward" && pages <= 2) return { Items: [], LastEvaluatedKey: { pk, sk: pages === 1 ? "PROJECT#zulu" : "PROJECT#alpha" } };
      return { Items: [] };
    }
    return w.rawSend(command);
  });
  const result = await w.impact();
  expect(result.status).toBe(200);
  expect(result.body.disconnectBlockers).toEqual({ kind: "unknown", reason: "read_unavailable" });
});
