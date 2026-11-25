import { beforeAll, expect, it, vi } from "vitest";
import { InstallRovaraAi, ROVARA_AI_PAUSED, ROVARA_AI_SETTING } from "../../packages/model-gateway/src/rovara-ai-stop.js";
import type { Item } from "../../packages/model-gateway/src/dynamo.js";
import { call, claims, mint, requestBody, setup, answer, scope } from "./model-gateway-fixture.js";
import { denyNetwork } from "./model-gateway-no-network.js";

beforeAll(denyNetwork);
const pausedWords = "Rovara's AI is paused on this install. Your work is safe; try again later or use your own AI source.";
const malformedSettings: Array<{ label: string; row: Item }> = [
  { label: "missing enabled", row: { ...ROVARA_AI_SETTING } },
  { label: "string enabled", row: { ...ROVARA_AI_SETTING, enabled: "false" } },
];

it("reads only the reserved key, defaults ON, and observes both toggles within 60s without redeploy", async () => {
  let clock = 0;
  let enabled: boolean | undefined;
  const get = vi.fn(async () => enabled === undefined ? undefined : { ...ROVARA_AI_SETTING, enabled });
  const setting = new InstallRovaraAi({ get }, "companies", () => clock);
  expect(await setting.enabled()).toBe(true);
  enabled = false;
  clock = 59_999;
  expect(await setting.enabled()).toBe(true);
  clock = 60_000;
  expect(await setting.enabled()).toBe(false);
  enabled = true;
  clock = 120_000;
  expect(await setting.enabled()).toBe(true);
  expect(get.mock.calls).toEqual(Array.from({ length: 3 }, () => ["companies", { pk: "INSTALL#ROVARA_AI", sk: "SETTING" }, { consistent: true }]));
});

it("unreadable settings fail closed and do not refresh a stale enabled cache", async () => {
  let clock = 0;
  const get = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...ROVARA_AI_SETTING, enabled: false });
  const setting = new InstallRovaraAi({ get }, "companies", () => clock);
  expect(await setting.enabled()).toBe(true);
  clock = 60_000;
  await expect(setting.enabled()).rejects.toThrow();
  expect(await setting.enabled()).toBe(false);
});

it.each(malformedSettings)("a present setting with $label fails closed", async ({ row }) => {
  const setting = new InstallRovaraAi({ get: async () => row }, "companies");
  expect(await setting.enabled().catch(() => false)).toBe(false);
});

function world() {
  const enabled = vi.fn(async () => false);
  const send = vi.fn(async () => ({ status: 200, body: answer() }));
  const g = setup({ rovaraAiSetting: { enabled }, agentKeys: { connected: async () => true, keyFor: async () => "fixture" },
    agentAi: { sources: { sourceFor: async () => "rovara" }, rovara: { models: new Map([[claims.mdl[0]!, "us.anthropic.claude-sonnet-4-5-20250929-v1:0"]]), exempt: new Set([claims.cid]), transport: send } }, transport: send });
  const reserve = vi.spyOn(g.meter, "reserve");
  return { ...g, enabled, send, reserve };
}

it.each(malformedSettings)("a present setting with $label returns 403 before any reserve/hold or send", async ({ row }) => {
  const g = world();
  const get = vi.fn(async () => row);
  g.deps.rovaraAiSetting = new InstallRovaraAi({ get }, "companies");
  const sink = await call(g.deps);
  expect(sink.status).toBe(403);
  expect(JSON.parse(sink.text())).toEqual({ error: { type: "not_allowed", message: pausedWords } });
  expect(get).toHaveBeenCalledTimes(1);
  expect(g.reserve).not.toHaveBeenCalled();
  expect(await g.meter.read(scope)).toEqual(expect.arrayContaining([
    expect.objectContaining({ item: "company", reservedMicros: 0, spentMicros: 0, committed: 0 }),
  ]));
  expect(g.send).not.toHaveBeenCalled();
  expect(g.meter.billedCalls(claims.iss, claims.cid)).toEqual([]);
});

it.each(["build", "setup", "upkeep", "reviewer", "e2e_agent", "slack_company_chat"])("%s: paused even for Demo, before any hold/send, exact refusal and zero spend", async stp => {
  const g = world();
  const sink = await call(g.deps, requestBody, mint({ stp }));
  expect(sink.status).toBe(403);
  expect(JSON.parse(sink.text())).toEqual({ error: { type: "not_allowed", message: pausedWords } });
  expect(ROVARA_AI_PAUSED.message).toBe(pausedWords);
  expect(g.reserve).not.toHaveBeenCalled();
  expect(g.send).not.toHaveBeenCalled();
  expect(g.meter.billedCalls(claims.iss, claims.cid)).toEqual([]);
});

it("a running task's next call refuses once without another hold/send/charge", async () => {
  const g = world();
  g.enabled.mockResolvedValueOnce(true);
  const token = mint();
  expect((await call(g.deps, requestBody, token)).status).toBe(200);
  const holds = g.reserve.mock.calls.length;
  const charges = g.meter.billedCalls(claims.iss, claims.cid);
  expect((await call(g.deps, requestBody, token)).status).toBe(403);
  expect(g.enabled).toHaveBeenCalledTimes(2);
  expect(g.send).toHaveBeenCalledTimes(1);
  expect(g.reserve).toHaveBeenCalledTimes(holds);
  expect(g.meter.billedCalls(claims.iss, claims.cid)).toEqual(charges);
});

it("own Anthropic key ignores the install stop and never reads the setting", async () => {
  const g = world();
  g.deps.agentAi!.sources = { sourceFor: async () => "anthropic_key" };
  expect((await call(g.deps)).status).toBe(200);
  expect(g.enabled).not.toHaveBeenCalled();
  expect(g.send).toHaveBeenCalledTimes(1);
});

it("an expired setting read failure returns the exact pause before holding or sending", async () => {
  const g = world();
  g.enabled.mockRejectedValue(new Error("setting offline"));
  const sink = await call(g.deps);
  expect(sink.status).toBe(403);
  expect((JSON.parse(sink.text()) as { error: { message: string } }).error.message).toBe(pausedWords);
  expect(g.reserve).not.toHaveBeenCalled();
  expect(g.send).not.toHaveBeenCalled();
});
