import { describe, expect, it, vi } from "vitest";
import { developerTaskPolicy, IMPLICIT_COMPANY_ID, orgProjectCatalogKey, projectRevisionKey } from "@agentx/contracts";
import * as appModule from "../../packages/broker/src/core-host/app.js";
import type { CoreHostAppOptions } from "../../packages/broker/src/core-host/app.js";
import { CORE_AREAS } from "../../packages/broker/src/core-host/flags.js";
import { buildCoreRegistry } from "../../packages/broker/src/core-host/registry.js";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { createHarness, definition } from "../support/task-flow-harness.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";

async function world(share: "optional" | "required" = "optional", registered = true) {
  const w = createFakeWorld();
  if (registered) {
    await w.store.put({ item: { ...orgProjectCatalogKey(IMPLICIT_COMPANY_ID, "payments"), latestRevision: 1 } });
    await w.store.put({ item: toDocument({ ...projectRevisionKey(IMPLICIT_COMPANY_ID, "payments", 1), definition: { ...definition, developerTasks: { ...developerTaskPolicy(definition), share } } }) });
  }
  let captured: CoreHostAppOptions["runtime"] | undefined;
  const original = appModule.createCoreHostApp;
  const spy = vi.spyOn(appModule, "createCoreHostApp").mockImplementation(options => { captured = options.runtime; return original(options); });
  let lookups = 0;
  try {
    createBrokerCoreRoot({ env: {}, documentClient: { send: async () => ({}) }, stateTableName: "state", signInTableName: "signin",
      callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1), repositoryCredential: async () => ({ token: "fixture" }),
      codeModules: () => { throw new Error("the test does not build AWS adapters"); }, origin: () => "https://api.example", log: () => undefined,
      taskRules: () => {
        lookups += 1;
        return { slackTeamId: "T0123456789", projectChannelIds: async () => ["C0123456789"], boundChannels: async () => [{ channelId: "C0123456789", name: "payments", isPrivate: false }] } as unknown as DeveloperTaskRouteDependencies;
      },
    });
    if (captured === undefined) throw new Error("runtime was not wired");
    const registry = await buildCoreRegistry({ modules: w.modules, context: w.context(), areas: [...CORE_AREAS] });
    const sharing = captured(registry, IMPLICIT_COMPANY_ID).flowOptions?.taskSharing;
    if (sharing === undefined) throw new Error("share preparation was not wired");
    return { prepare: sharing.prepare.bind(sharing), caller: createHarness().owner, lookups: () => lookups };
  } finally { spy.mockRestore(); }
}

describe("merged hosted task sharing", () => {
  it("refuses an absent project before consulting sharing dependencies", async () => {
    const w = await world("optional", false);
    await expect(w.prepare(w.caller, "payments", { shareToChannel: true })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.lookups()).toBe(0);
  });
  it("keeps an optional private start independent of channel lookups", async () => {
    const w = await world();
    expect(await w.prepare(w.caller, "payments", { shareToChannel: false })).toBeUndefined();
    expect(w.lookups()).toBe(0);
  });
  it.each([false, true])("shares a required project with shareToChannel=%s", async shareToChannel => {
    const w = await world("required");
    expect(await w.prepare(w.caller, "payments", { shareToChannel })).toMatchObject({ channelId: "C0123456789", ...(shareToChannel ? {} : { sharedReason: "required" }) });
    expect(w.lookups()).toBe(1);
  });
  it("honors an explicit optional share", async () => {
    const w = await world();
    expect(await w.prepare(w.caller, "payments", { shareToChannel: true })).toMatchObject({ channelId: "C0123456789" });
    expect(w.lookups()).toBe(1);
  });
});
