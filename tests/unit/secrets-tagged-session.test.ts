import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand, UntagResourceCommand } from "@aws-sdk/client-secrets-manager";
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
    for(const session of fake.sessions) {expect(session.durationSeconds).toBe(900); expect(session.sessionName).toMatch(new RegExp(`^rovara-secrets-${session.tags[0]!.Value}-[0-9a-f]{16}$`, "u")); expect(session.sessionName.length).toBeLessThanOrEqual(64);}
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
    expect(new Set(fake.sessions.map(session=>session.sessionName)).size).toBe(fake.sessions.length);
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


it("tags hook secrets as hook and connector secrets as connector", async () => {
  const fake = new CompanySecretsManagerFake();
  const writer = createSecretsManagerConnectionSecrets({env:"local",clientFor:createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom})});
  for (const [path,use] of [["org-hooks","hook"],["org-connectors","connector"]]) {
    const secret = `agentx/local/${path}/${A}/shared-secret`;
    await writer.put(A,secret,"value");
    expect(fake.secrets.get(secret)?.tags).toEqual({"rovara:org":A,"rovara:use":use});
  }
});

it.each([
  {action:"GetSecretValue",command:(SecretId:string)=>new GetSecretValueCommand({SecretId})},
  {action:"DescribeSecret",command:(SecretId:string)=>new DescribeSecretCommand({SecretId})},
  {action:"PutSecretValue",command:(SecretId:string)=>new PutSecretValueCommand({SecretId,SecretString:"updated"})},
  {action:"DeleteSecret",command:(SecretId:string)=>new DeleteSecretCommand({SecretId,RecoveryWindowInDays:7})},
])("IAM fake authorizes $action by path before existence, independent of resource tags", async ({command}) => {
  const fake = new CompanySecretsManagerFake();
  const clientFor = createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom});
  const a = await clientFor(A);
  await expect(a.send(command(name(A)))).rejects.toMatchObject({name:"ResourceNotFoundException"});
  await expect(a.send(command(name(B)))).rejects.toMatchObject({name:"AccessDeniedException"});
  for (const tags of [{}, {"rovara:org":B}]) {
    fake.seed(name(A),"legacy",tags);
    await expect(a.send(command(name(A)))).resolves.toBeDefined();
  }
  fake.seed(name(B),"foreign",{"rovara:org":A});
  await expect(a.send(command(name(B)))).rejects.toMatchObject({name:"AccessDeniedException"});
  for (const outside of [name(A).replace("/local/","/other/"), name(A).replace("agentx/","elsewhere/"), name(A).replace("org-connectors/","install-secrets/"), `agentx/local/org-connectors/${A}`]) {
    await expect(a.send(command(outside))).rejects.toMatchObject({name:"AccessDeniedException"});
  }
});

it("IAM fake permits matching creation tags only at create and forbids org tag edits on existing secrets", async () => {
  const fake = new CompanySecretsManagerFake();
  const a = await createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom})(A);
  for (const Tags of [undefined, [], [{Key:"rovara:org",Value:B}]]) {
    await expect(a.send(new CreateSecretCommand({Name:name(A),SecretString:"value",Tags}))).rejects.toMatchObject({name:"AccessDeniedException"});
  }
  await expect(a.send(new CreateSecretCommand({Name:name(B),SecretString:"value",Tags:[{Key:"rovara:org",Value:A}]}))).rejects.toMatchObject({name:"AccessDeniedException"});
  await expect(a.send(new CreateSecretCommand({Name:name(A),SecretString:"value",Tags:[{Key:"rovara:org",Value:A}]}))).resolves.toBeDefined();
  // An idempotent create still reaches ResourceExists so the writer can rotate via Put.
  await expect(a.send(new CreateSecretCommand({Name:name(A),SecretString:"value",Tags:[{Key:"rovara:org",Value:A}]}))).rejects.toMatchObject({name:"ResourceExistsException"});
  for (const tags of [{"rovara:org":A}, {}]) {
    fake.seed(name(A),"value",tags);
    for (const Value of [A,B]) await expect(a.send(new TagResourceCommand({SecretId:name(A),Tags:[{Key:"rovara:org",Value}]}))).rejects.toMatchObject({name:"AccessDeniedException"});
    await expect(a.send(new UntagResourceCommand({SecretId:name(A),TagKeys:["rovara:org"]}))).rejects.toMatchObject({name:"AccessDeniedException"});
    await expect(a.send(new TagResourceCommand({SecretId:name(A),Tags:[{Key:"rovara:use",Value:"connector"}]}))).resolves.toBeDefined();
    await expect(a.send(new UntagResourceCommand({SecretId:name(A),TagKeys:["rovara:use"]}))).resolves.toBeDefined();
    expect(fake.secrets.get(name(A))?.tags).toEqual(tags);
  }
});
