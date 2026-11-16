import type * as Crypto from "node:crypto";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { createSecretsManagerSecretStore } from "../../packages/aws-adapters/src/secrets-manager/index.js";
import { COMPANY_SECRET_PATHS } from "../../packages/aws-adapters/src/secrets-manager/company-names.js";
import { createLocalConnectionSecrets } from "../../packages/broker/src/connections/local-secrets.js";
import { createLocalSecretStore } from "../../packages/broker/src/ports/secret-stores.js";
import { createAdapterRegistry, loadAdapters, parsePluginConfig } from "../../packages/broker/src/ports/adapter-registry.js";
import { secretsManagerSecretsPlugin, SecretsManagerSettingsSchema } from "../../packages/broker/src/plugins/secrets/aws-secrets-manager/plugin.js";
import { FakeSecretsManager } from "../support/ports/aws-fakes.js";
vi.mock("node:crypto", async (original) => ({ ...await original<typeof Crypto>(), randomBytes: () => Buffer.from("01020304", "hex") }));
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb", PREFIX = "agentx/local/";
function world() {
  const service = new FakeSecretsManager();
  const store = createSecretsManagerSecretStore({namePrefix: PREFIX, clientFor: () => service, companyPaths: COMPANY_SECRET_PATHS, unscopedNamesBelongTo: IMPLICIT_COMPANY_ID});
  return {service, store};
}
describe("company adapter", () => {
  it("same answer for existing and missing other-company names, with no AWS calls", async () => {
    const {service, store} = world();
    for (const path of ["org-connectors", "org-hooks", "org-test-accounts"]) {
      service.set(`${PREFIX}${path}/${B}/exists`, "private-value");
      expect(await store.read(A, {awsSecret:`${path}/${B}/exists`})).toEqual(await store.read(A, {awsSecret:`${path}/${B}/missing`}));
      expect(await store.read(A, {awsSecret:`${path}/${B}/exists`})).toBeUndefined();
    }
    expect(service.reads).toEqual([]);
    for (const path of ["org-connectors", "org-hooks", "org-test-accounts"]) {
      service.set(`${PREFIX}${path}/${A}/own`, "own");
      expect((await store.read(A, {awsSecret:`${path}/${A}/own`}))?.reveal()).toBe("own");
    }
    expect(await store.read(A, {awsSecret:`org-connectors/${A}/missing`})).toBeUndefined();
  });
  it("assigns old unscoped names only to the implicit company", async () => {
    const {service, store} = world(); service.set(`${PREFIX}legacy`, "old");
    expect(await store.read(A, {awsSecret:"legacy"})).toBeUndefined();
    expect(service.reads).toEqual([]);
    expect((await store.read(IMPLICIT_COMPANY_ID, {awsSecret:"legacy"}))?.reveal()).toBe("old");
  });
  it("refuses every unscoped read when companyPaths has no explicit owner, including plugin settings without hosted", async () => {
    const service = new FakeSecretsManager(); service.set(`${PREFIX}legacy`, "old");
    for (const companyPaths of [COMPANY_SECRET_PATHS, []]) {
      const direct = createSecretsManagerSecretStore({namePrefix:PREFIX,companyPaths,clientFor:()=>service});
      const registry = createAdapterRegistry();
      await loadAdapters(parsePluginConfig({version:1,plugins:[{point:"secrets",name:"aws-secrets-manager",module:"test",settings:{region:"us-west-2",profile:"test",namePrefix:PREFIX,companyPaths}}]}), {registry,importModule:async()=>({plugin:secretsManagerSecretsPlugin({clientFor:()=>service})})});
      for (const store of [direct, registry.require("secrets")]) {
        for (const company of [A,B,IMPLICIT_COMPANY_ID]) expect(await store.read(company,{awsSecret:"legacy"})).toBeUndefined();
      }
    }
    expect(service.reads).toEqual([]);
  });
  it("refuses malformed companies, lookalikes and runtime references without leaking or reading", async () => {
    const {service, store} = world();
    for (const company of [null, {}, "bad", `${A}a`]) await expect(store.read(company as string, {awsSecret:`org-connectors/${A}/own`})).rejects.toThrow(/^the secret reference is not valid$/u);
    for (const ref of [null, {}, {awsSecret: 3}, {awsSecret:`org-connectors/${A}a/x`}, {awsSecret:`org-connectors/${A}/../x`}]) await expect(store.read(A, ref as {awsSecret:string})).rejects.toThrow(/^the secret reference is not valid$/u);
    expect(service.reads).toEqual([]);
  });
  it("bounds oversized input before splitting it", async () => {
    const {store, service} = world(); const start = performance.now();
    await expect(store.read(A, {awsSecret:"a/".repeat(500_000)})).rejects.toThrow("the secret reference is not valid");
    expect(performance.now() - start).toBeLessThan(1000); expect(service.reads).toEqual([]);
  });
  it("hosted settings enforce all families and legacy ownership", async () => {
    expect(SecretsManagerSettingsSchema.safeParse({region:"us-west-2",profile:"test",namePrefix:PREFIX,hosted:"true"}).success).toBe(false);
    const service = new FakeSecretsManager(); service.set(`${PREFIX}legacy`, "old");
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({version:1,plugins:[{point:"secrets",name:"aws-secrets-manager",module:"test",settings:{region:"us-west-2",profile:"test",namePrefix:PREFIX,hosted:true}}]}), {registry,importModule:async()=>({plugin:secretsManagerSecretsPlugin({clientFor:()=>service})})});
    const store = registry.require("secrets");
    for (const path of ["org-connectors", "org-hooks", "org-test-accounts"]) {
      service.set(`${PREFIX}${path}/${B}/x`, "private"); expect(await store.read(A,{awsSecret:`${path}/${B}/x`})).toBeUndefined();
    }
    expect(await store.read(A,{awsSecret:"legacy"})).toBeUndefined(); expect(service.reads).toEqual([]);
    expect((await store.read(IMPLICIT_COMPANY_ID,{awsSecret:"legacy"}))?.reveal()).toBe("old");
  });
});
describe("pre-edit byte goldens", () => {
  it("keeps the absent-options adapter output and AWS log byte-identical", async () => {
    const results = [];
    for (const kind of ["own","missing","denied","deleted","empty","binary","bad-name","other-company-looking"]) {
      const calls: unknown[] = [];
      const store = createSecretsManagerSecretStore({namePrefix:PREFIX, clientFor:()=>({send:async(command)=>{
        calls.push(command.input);
        const name = ({missing:"ResourceNotFoundException", denied:"AccessDeniedException", deleted:"InvalidRequestException"} as Record<string,string>)[kind];
        if(name) throw Object.assign(new Error("private-cause"),{name});
        return kind === "binary" ? {SecretBinary:new Uint8Array([1])} : {SecretString:kind === "empty" ? "  " : " value "};
      }})});
      const name = kind === "bad-name" ? "../escape" : kind === "other-company-looking" ? `org-connectors/${B}/shared-secret` : "shared-secret";
      const result = await store.read(IMPLICIT_COMPANY_ID,{awsSecret:name}).then(value=>({value:value?.reveal() ?? null}), (error: Error)=>({error:error.message}));
      results.push({kind,...result,calls});
    }
    expect(JSON.stringify(results,null,2)+"\n").toBe(await readFile(new URL("../fixtures/secrets-company-goldens/adapter.json",import.meta.url),"utf8"));
  });
  it("keeps implicit-company local put/version/latest/delete bytes", async () => {
    const directory = await realpath(await mkdtemp(join(process.env.TMPDIR!, "t6-golden-")));
    try {
      const store = createLocalConnectionSecrets({directory,secrets:createLocalSecretStore({environment:{}}),companyId:IMPLICIT_COMPANY_ID,env:"local",now:()=>1700000000000});
      const name = `${PREFIX}org-connectors/${IMPLICIT_COMPANY_ID}/shared-secret`;
      const version = await store.put(IMPLICIT_COMPANY_ID,name,"local-value");
      const result = {version,byVersion:await store.read(IMPLICIT_COMPANY_ID,name,version),latest:await store.read(IMPLICIT_COMPANY_ID,name),afterDelete:null as string|null};
      await store.scheduleDelete(IMPLICIT_COMPANY_ID,name); result.afterDelete = await store.read(IMPLICIT_COMPANY_ID,name) ?? null;
      expect(JSON.stringify(result,null,2)+"\n").toBe(await readFile(new URL("../fixtures/secrets-company-goldens/local.json",import.meta.url),"utf8"));
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
});
