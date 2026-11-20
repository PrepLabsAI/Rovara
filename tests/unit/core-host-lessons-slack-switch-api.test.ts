
import { type OrgId } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { DEV_ROUTES } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { LESSONS_SLACK_PATH, NOT_FOR_SCRIPT_TOKENS_SLACK, createLessonsSlackSwitchApi, isLessonsSlackSwitchPath, type LessonsSlackSwitchCaller } from "../../packages/broker/src/core-host/lessons-slack-switch-api.js";
import { readSlackOptOut, slackSwitchKey } from "../../packages/broker/src/lessons/slack-switch.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

/** The words of the refusal a promise ends with ("" when it does not refuse). */
const messageOf = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return ""; } catch (error) { return error instanceof Error ? error.message : ""; } };
const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const now = (): number => 1_800_000_000_000;
const members: Record<string, string> = { ann: A, bob: A, zed: B };

function api(store = new MemoryDocumentStore(), over: { companyOf?: Parameters<typeof createLessonsSlackSwitchApi>[0]["companyOf"] } = {}) {
  return { store, api: createLessonsSlackSwitchApi({ store, now, companyOf: over.companyOf ?? (async (caller) => (members[caller.personId] === undefined ? undefined : { companyId: members[caller.personId]! })) }) };
}
const get = (a: ReturnType<typeof api>, caller: LessonsSlackSwitchCaller) => a.api.answer({ method: "GET", path: LESSONS_SLACK_PATH }, caller);
const put = (a: ReturnType<typeof api>, caller: LessonsSlackSwitchCaller, body: unknown) => a.api.answer({ method: "PUT", path: LESSONS_SLACK_PATH, body: typeof body === "string" ? body : JSON.stringify(body) }, caller);

describe("the person's switch", () => {
  it("is off until the person turns it on; turning it on records only their own row; turning it off removes the row", async () => {
    const a = api();
    expect(await get(a, { personId: "ann" })).toEqual({ optOut: false });
    expect(await put(a, { personId: "ann" }, { optOut: true })).toEqual({ optOut: true });
    expect(await get(a, { personId: "ann" })).toEqual({ optOut: true });
    expect(await a.store.get(slackSwitchKey(A, "ann"))).toMatchObject({ entityType: "LESSON_SLACK_SWITCH", companyId: A, personId: "ann", optOut: true, updatedAt: now() });
    expect(await put(a, { personId: "ann" }, { optOut: false })).toEqual({ optOut: false });
    expect(await a.store.get(slackSwitchKey(A, "ann"))).toBeUndefined();
  });
  it("is the caller's own: no path, query or body names a person, so another person's switch is never touched", async () => {
    const a = api();
    await put(a, { personId: "ann" }, { optOut: true });
    expect(await get(a, { personId: "bob" })).toEqual({ optOut: false });
    await expect(put(a, { personId: "bob" }, { optOut: true, personId: "ann" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(a.api.answer({ method: "GET", path: `${LESSONS_SLACK_PATH}/ann` }, { personId: "bob" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("a script token neither reads nor sets it", async () => {
    const a = api();
    await expect(get(a, { personId: "ann", scriptToken: { tokenId: "t" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(get(a, { personId: "ann", scriptToken: { tokenId: "t" } })).rejects.toThrow(NOT_FOR_SCRIPT_TOKENS_SLACK);
    await expect(put(a, { personId: "ann", scriptToken: { tokenId: "t" } }, { optOut: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readSlackOptOut(a.store, A, "ann")).toBe(false);
  });
  it("sign in again when membership gives nothing, something malformed, or throws", async () => {
    for (const companyOf of [async () => undefined, async () => ({ companyId: "not-a-company" }), async () => { throw new Error("down"); }, async () => null as never]) {
      const a = api(new MemoryDocumentStore(), { companyOf });
      await expect(get(a, { personId: "ann" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await expect(put(a, { personId: "ann" }, { optOut: true })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    }
  });
  it("refuses a body that is not exactly optOut true or false, and a method or path that is not this route's", async () => {
    const a = api();
    for (const body of ["", "not json", "{}", { optOut: "yes" }, { optOut: 1 }, { optOut: true, extra: 1 }, []]) await expect(put(a, { personId: "ann" }, body), JSON.stringify(body)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(a.api.answer({ method: "POST", path: LESSONS_SLACK_PATH }, { personId: "ann" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(a.api.answer({ method: "DELETE", path: LESSONS_SLACK_PATH }, { personId: "ann" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await readSlackOptOut(a.store, A, "ann")).toBe(false);
  });
  it("a person id that cannot be a key part fails with a fixed answer and writes nothing", async () => {
    const a = api(new MemoryDocumentStore(), { companyOf: async () => ({ companyId: A }) });
    await expect(put(a, { personId: "a#b" }, { optOut: true })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(get(a, { personId: "a#b" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
  it("takes the store late when the deployment makes it late, and a store that cannot be made is a fixed answer", async () => {
    const store = new MemoryDocumentStore();
    const late = createLessonsSlackSwitchApi({ store: async () => store, now, companyOf: async () => ({ companyId: A }) });
    await late.answer({ method: "PUT", path: LESSONS_SLACK_PATH, body: JSON.stringify({ optOut: true }) }, { personId: "ann" });
    expect(await readSlackOptOut(store, A, "ann")).toBe(true);
    const broken = createLessonsSlackSwitchApi({ store: async () => { throw new Error("secret registry"); }, now, companyOf: async () => ({ companyId: A }) });
    await expect(broken.answer({ method: "GET", path: LESSONS_SLACK_PATH }, { personId: "ann" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await messageOf(broken.answer({ method: "GET", path: LESSONS_SLACK_PATH }, { personId: "ann" }))).not.toContain("secret");
  });
  it("is in the dev route table with full access only, and the path test matches exactly that path", () => {
    expect(DEV_ROUTES.filter((route) => route.path === LESSONS_SLACK_PATH).map((route) => `${route.method} ${route.requires}`).sort()).toEqual(["GET full", "PUT full"]);
    expect(isLessonsSlackSwitchPath(LESSONS_SLACK_PATH)).toBe(true);
    for (const other of ["/v1/dev/me/lessons-slack/", "/v1/dev/me/lessons-slackx", "/v1/dev/me", "/v1/dev/projects/p/lessons-slack"]) expect(isLessonsSlackSwitchPath(other), other).toBe(false);
  });
});
