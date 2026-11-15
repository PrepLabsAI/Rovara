import { mkdtemp, realpath, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { createCompanySecretStore } from "../../packages/testing/src/isolation/secret-ledger.js";
import { createMemberSecretReader, memberBoundConnectionSecrets } from "../../packages/broker/src/connections/company-secrets.js";
import { LocalSecretError } from "../../packages/broker/src/ports/secret-error.js";
import { createLocalConnectionSecrets } from "../../packages/broker/src/connections/local-secrets.js";
import { createLocalSecretStore } from "../../packages/broker/src/ports/secret-stores.js";
import { InMemoryConnectionSecrets } from "../support/connection-fakes.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const name = (company: string) => `agentx/local/org-connectors/${company}/shared-secret`;
const REF = {awsSecret:"shared-secret"};
const REFUSAL = "the person's company could not be confirmed";
describe("membership-bound secrets", () => {
  it("reads membership once per call, never derives it from the reference, and revokes immediately", async () => {
    const store = createCompanySecretStore(); store.set(A,REF,"a"); store.set(B,REF,"b");
    let company: string | undefined = A; const people: string[] = [];
    const reader = createMemberSecretReader({companies:{companyOf:async(personId)=>{people.push(personId);return company;}},store});
    expect((await store.actingFor(A,()=>reader.readAs("person-a",REF)))?.reveal()).toBe("a");
    company = B; expect((await reader.readAs("person-a",REF))?.reveal()).toBe("b");
    company = undefined; await expect(reader.readAs("person-a",REF)).rejects.toThrow(REFUSAL);
    expect(people).toEqual(["person-a","person-a","person-a"]); expect(store.reads).toHaveLength(2);
  });
  it("fails closed with one sentence for throws, missing and malformed membership, never implicit fallback", async () => {
    for (const mode of ["throws",undefined,"not-an-org",null,{},42]) {
      const store = createCompanySecretStore(); store.set(IMPLICIT_COMPANY_ID,REF,"private-value");
      const companies = {companyOf:async()=>{if(mode === "throws") throw new Error(`private-value ${A}`);return mode as string|undefined;}};
      const reader = createMemberSecretReader({companies,store});
      await expect(reader.readAs("person-a",REF)).rejects.toBeInstanceOf(LocalSecretError);
      await expect(reader.readAs("person-a",REF)).rejects.toThrow(new RegExp(`^${REFUSAL}$`,"u"));
      expect(store.reads).toEqual([]);
      const inner = new InMemoryConnectionSecrets("local");
      const bound = memberBoundConnectionSecrets({companies,personId:"person-a",inner});
      for (const call of [()=>bound.read(A,name(A)),()=>bound.put(A,name(A),"x"),()=>bound.scheduleDelete(A,name(A))]) await expect(call()).rejects.toThrow(REFUSAL);
      expect(inner.calls).toEqual([]);
    }
  });
  it("ignores a mismatched org argument on reads and refuses writes/deletes before inner calls", async () => {
    const inner = new InMemoryConnectionSecrets("local"); await inner.put(A,name(A),"a"); await inner.put(B,name(B),"b"); inner.calls.length = 0;
    let count = 0; let company: string|undefined = A;
    const bound = memberBoundConnectionSecrets({companies:{companyOf:async()=>{count++;return company;}},personId:"person-a",inner});
    expect(await bound.read(B,name(B))).toBeUndefined();
    await expect(bound.put(B,name(B),"bad")).rejects.toMatchObject({code:"FORBIDDEN",message:"FORBIDDEN: that secret does not belong to this company"});
    await expect(bound.scheduleDelete(B,name(B))).rejects.toMatchObject({code:"FORBIDDEN"});
    expect(inner.calls).toEqual([]); expect(count).toBe(3);
    // The argument is a bug guard even when the supplied name happens to be our own.
    await expect(bound.put(B,name(A),"bad")).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(bound.scheduleDelete(B,name(A))).rejects.toMatchObject({code:"FORBIDDEN"});
    expect(inner.calls).toEqual([]);
    const version = await bound.put(A,name(A),"new"); expect(await bound.read(A,name(A),version)).toBe("new");
    company = undefined; await expect(bound.read(A,name(A))).rejects.toThrow(REFUSAL);
    company = A; await bound.scheduleDelete(A,name(A)); expect(await bound.read(A,name(A))).toBeUndefined(); expect(await inner.read(B,name(B))).toBe("b");
  });
  it("local and fake reads return missing only for VALID other-company names, without touching files", async () => {
    const directory = await realpath(await mkdtemp(join(process.env.TMPDIR!,"t6-member-")));
    try {
      const local = createLocalConnectionSecrets({directory,secrets:createLocalSecretStore({environment:{}}),companyId:A,env:"local"});
      for (const inner of [local,new InMemoryConnectionSecrets("local")]) {
        expect(await inner.read(A,name(B))).toBeUndefined();
        for (const bad of [name(`${B}b`),`${name(B)}/../x`,null,42]) await expect(inner.read(A,bad as string)).rejects.toMatchObject({code:"FORBIDDEN"});
        await expect(inner.read("bad",name(B))).rejects.toMatchObject({code:"FORBIDDEN"});
      }
      expect(await readdir(directory)).toEqual([]);
    } finally {await rm(directory,{recursive:true,force:true});}
  });
});
