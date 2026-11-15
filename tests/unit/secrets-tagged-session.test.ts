import { GetSecretValueCommand, TagResourceCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { createCompanyClientFactory } from "../../packages/aws-adapters/src/secrets-manager/tagged-session.js";
import { createSecretsManagerConnectionSecrets } from "../../packages/aws-adapters/src/secrets-manager/connection-secrets.js";
import { createSecretsManagerSecretStore } from "../../packages/aws-adapters/src/secrets-manager/index.js";
import { COMPANY_SECRET_PATHS } from "../../packages/aws-adapters/src/secrets-manager/company-names.js";
import type { ConnectionSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { CompanySecretsManagerFake } from "../support/ports/secrets-manager-company-fake.js";
const A="org_aaaaaaaaaaaaaaaaaaaa", B="org_bbbbbbbbbbbbbbbbbbbb";
const name=(company:string)=>`agentx/local/org-connectors/${company}/shared-secret`;
describe("tagged sessions and connection writer",()=>{
  it("single-flights per company, never shares credentials, tags the create and preserves versions",async()=>{
    const fake = new CompanySecretsManagerFake();
    const clientFor=createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom});
    const [a,a2,b]=await Promise.all([clientFor(A),clientFor(A),clientFor(B)]);
    expect(a).toBe(a2);expect(a).not.toBe(b);expect(fake.sessions.map(s=>s.tags)).toEqual([[{Key:"rovara:org",Value:A}],[{Key:"rovara:org",Value:B}]]);
    for(const session of fake.sessions) {expect(session.durationSeconds).toBe(900); expect(session.sessionName).not.toContain(A);}
    const writer: ConnectionSecrets=createSecretsManagerConnectionSecrets({env:"local",clientFor});
    const v1=await writer.put(A,name(A),"one");const v2=await writer.put(A,name(A),"two");expect(v1).not.toBe(v2);
    expect(fake.secrets.get(name(A))?.tags).toEqual({"rovara:org":A,"rovara:use":"connector"});
    expect(await writer.read(A,name(A),v1)).toBe("one");expect(await writer.read(A,name(A))).toBe("two");
    expect(await writer.read(A,name(A),"missing-version")).toBeUndefined();
    await writer.scheduleDelete(A,name(A)); expect(await writer.read(A,name(A))).toBeUndefined();
    expect(fake.deletions).toEqual([{SecretId:name(A),RecoveryWindowInDays:7}]);
    await writer.scheduleDelete(B,name(B));
  });
  it("IAM fake denies direct cross-company reads and org tag rewriting, adapter maps AccessDenied to fixed words",async()=>{
    const fake = new CompanySecretsManagerFake();const clientFor=createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom});
    const writer=createSecretsManagerConnectionSecrets({env:"local",clientFor});await writer.put(A,name(A),"private");
    const b=await clientFor(B);
    await expect(b.send(new GetSecretValueCommand({SecretId:name(A)}))).rejects.toMatchObject({name:"AccessDeniedException"});
    const a=await clientFor(A);
    await expect(a.send(new TagResourceCommand({SecretId:name(A),Tags:[{Key:"rovara:org",Value:B}]}))).rejects.toMatchObject({name:"AccessDeniedException"});
    const adapter=createSecretsManagerSecretStore({namePrefix:"agentx/local/",clientFor:()=>b});
    await expect(adapter.read(B,{awsSecret:`org-connectors/${A}/shared-secret`})).rejects.toThrow(/^the secrets service refused to read this secret$/u);
  });
  it("writer preflights ownership, syntax and runtime values before any session or AWS call",async()=>{
    const fake=new CompanySecretsManagerFake();const writer=createSecretsManagerConnectionSecrets({env:"local",clientFor:createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom})});
    expect(await writer.read(B,name(A))).toBeUndefined();
    for(const action of [()=>writer.put(B,name(A),"x"),()=>writer.scheduleDelete(B,name(A))]) await expect(action()).rejects.toThrow(/^that secret does not belong to this company$/u);
    for(const bad of [null,42,`${name(A)}/../x`,name(`${A}a`)]) await expect(writer.read(A,bad as string)).rejects.toThrow(/^the secret reference is not valid$/u);
    await expect(writer.put(A,name(A),"x".repeat(16_385))).rejects.toThrow(/^secret: that is too long to be a key or a token$/u);
    await expect(writer.put(A,name(A),null as unknown as string)).rejects.toThrow(/^the secret reference is not valid$/u);
    await expect(writer.read(A,name(A),{} as string)).rejects.toThrow(/^the secret reference is not valid$/u);
    expect(fake.sessions).toEqual([]);expect(fake.calls).toEqual([]);
  });
  it("refreshes 60 seconds before expiry, single-flights refresh, and never caches failed assumeRole",async()=>{
    let now=1_700_000_000_000;const fake=new CompanySecretsManagerFake(()=>now);let fail=true;let attempts=0;
    const clientFor=createCompanyClientFactory({now:()=>now,clientFrom:fake.clientFrom,assumeRole:async(input)=>{attempts++;if(fail)throw new Error(`private ${A}`);return fake.assumeRole(input);}});
    await expect(clientFor(A)).rejects.toThrow(/^the secrets service could not be reached$/u);fail=false;
    const a=await clientFor(A);expect(attempts).toBe(2);now+=839_000;expect(await clientFor(A)).toBe(a);
    now+=1_000;const [next,next2]=await Promise.all([clientFor(A),clientFor(A)]);expect(next).not.toBe(a);expect(next2).toBe(next);expect(attempts).toBe(3);
    now+=901_000;expect(await clientFor(A)).not.toBe(next);
  });
  it("refuses malformed company and expired/invalid session responses with fixed errors",async()=>{
    const fake=new CompanySecretsManagerFake();const clientFor=createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom});
    for(const bad of [null,42,{},"bad"]) await expect(clientFor(bad as string)).rejects.toThrow(/^the secret reference is not valid$/u);
    expect(fake.sessions).toEqual([]);
    for(const expiresAt of [NaN,Infinity,Date.now()-1]) {
      const broken=createCompanyClientFactory({clientFrom:fake.clientFrom,assumeRole:async(input)=>({...await fake.assumeRole(input),expiresAt})});
      await expect(broken(A)).rejects.toThrow(/^the secrets service could not be reached$/u);
    }
  });
  it("only the implicit-company legacy path can use the unrestricted old install role",async()=>{
    const fake=new CompanySecretsManagerFake();fake.seed("agentx/local/legacy","old",{});
    const tagged=createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom});
    const adapter=createSecretsManagerSecretStore({namePrefix:"agentx/local/",companyPaths:COMPANY_SECRET_PATHS,unscopedNamesBelongTo:IMPLICIT_COMPANY_ID,clientFor:company=>company===IMPLICIT_COMPANY_ID?fake.unrestricted():tagged(company)});
    expect(await adapter.read(A,{awsSecret:"legacy"})).toBeUndefined();expect((await adapter.read(IMPLICIT_COMPANY_ID,{awsSecret:"legacy"}))?.reveal()).toBe("old");
    await expect((await tagged(A)).send(new GetSecretValueCommand({SecretId:"agentx/local/legacy"}))).rejects.toMatchObject({name:"AccessDeniedException"});
  });
  it("never leaks service causes on any writer failure path",async()=>{
    const error=Object.assign(new Error(`private ${A} ${name(A)}`),{name:"ServiceFailure"});
    const writer=createSecretsManagerConnectionSecrets({env:"local",clientFor:()=>({send:async()=>{throw error;}})});
    for(const action of [()=>writer.read(A,name(A)),()=>writer.put(A,name(A),"private"),()=>writer.scheduleDelete(A,name(A))]) await expect(action()).rejects.toThrow(/^the secrets service could not be reached$/u);
  });
});

it("writer sanitizes denied, scheduled, binary and missing-version response paths", async () => {
  for (const serviceName of ["AccessDeniedException", "InvalidRequestException", "DecryptionFailure"]) {
    const expected = serviceName === "AccessDeniedException" ? "the secrets service refused this operation" : serviceName === "InvalidRequestException" ? "this connection is being removed; remove it again, then add a new one" : "the secrets service could not be reached";
    const writer = createSecretsManagerConnectionSecrets({env:"local",clientFor:()=>({send:async()=>{throw Object.assign(new Error(`${A} ${name(A)} private`),{name:serviceName});}})});
    await expect(writer.put(A,name(A),"private")).rejects.toThrow(expected);
    await expect(writer.scheduleDelete(A,name(A))).rejects.toThrow(expected);
    if (serviceName === "InvalidRequestException") expect(await writer.read(A,name(A))).toBeUndefined();
    else await expect(writer.read(A,name(A))).rejects.toThrow(expected);
  }
  const binary = createSecretsManagerConnectionSecrets({env:"local",clientFor:()=>({send:async()=>({SecretBinary:new Uint8Array([1])})})});
  await expect(binary.read(A,name(A))).rejects.toThrow(/^the secret is not text$/u);
  const noVersion = createSecretsManagerConnectionSecrets({env:"local",clientFor:()=>({send:async()=>({})})});
  await expect(noVersion.put(A,name(A),"private")).rejects.toThrow(/^the secrets service could not be reached$/u);
});

it("session factory rejects malformed credentials and client construction failures without caching either", async () => {
  const fake = new CompanySecretsManagerFake();
  for (const credentials of [undefined, {accessKeyId:"",secretAccessKey:"fake",sessionToken:"fake"}, {accessKeyId:"fake",secretAccessKey:42,sessionToken:"fake"}]) {
    const factory = createCompanyClientFactory({clientFrom:()=>({built:true}),assumeRole:async()=>({credentials:credentials as never,expiresAt:Date.now()+900_000})});
    await expect(factory(A)).rejects.toThrow(/^the secrets service could not be reached$/u);
  }
  let fail = true;
  const factory = createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:(credentials)=>{if(fail) throw new Error(`${A} private`);return fake.clientFrom(credentials);}});
  await expect(factory(A)).rejects.toThrow(/^the secrets service could not be reached$/u);
  fail = false; await expect(factory(A)).resolves.toBeDefined(); expect(fake.sessions).toHaveLength(2);
});

it("accepts the full 16 KiB limit in one call and refuses larger multibyte values", async () => {
  const fake = new CompanySecretsManagerFake();
  const writer = createSecretsManagerConnectionSecrets({env:"local",clientFor:createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom})});
  const value = "é".repeat(8192);
  const start = performance.now();
  const version = await writer.put(A,name(A),value);
  expect(await writer.read(A,name(A),version)).toBe(value);
  await expect(writer.put(A,name(A),value+"é")).rejects.toThrow("secret: that is too long to be a key or a token");
  expect(fake.calls).toHaveLength(2);
  expect(performance.now()-start).toBeLessThan(1000);
});
