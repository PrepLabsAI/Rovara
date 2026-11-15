import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { createSecretsManagerSecretStore } from "../../../packages/aws-adapters/src/secrets-manager/index.js";
import { COMPANY_SECRET_PATHS } from "../../../packages/aws-adapters/src/secrets-manager/company-names.js";
import { createCompanyClientFactory } from "../../../packages/aws-adapters/src/secrets-manager/tagged-session.js";
import { createSecretsManagerConnectionSecrets } from "../../../packages/aws-adapters/src/secrets-manager/connection-secrets.js";
import { createMemberSecretReader, memberBoundConnectionSecrets } from "../../../packages/broker/src/connections/company-secrets.js";
import { createCompanySecretStore } from "../../../packages/testing/src/isolation/secret-ledger.js";
import { COMPANY_A, SHARED_RAW_IDS, attempt, type TwoCompanyIsolation, type IsolationSurface } from "../../../packages/testing/src/isolation/two-company.js";
import { CompanySecretsManagerFake } from "./secrets-manager-company-fake.js";
import { InMemoryConnectionSecrets } from "../connection-fakes.js";
export type SecretLeak = "name-check" | "fallback" | "shared-session" | "untagged-writer";
/** Every surface uses the same raw name for both companies; one shared fake AWS service. */
export function secretsCompanies(leak?:SecretLeak):TwoCompanyIsolation {
  const fake=new CompanySecretsManagerFake();
  const tagged=createCompanyClientFactory({assumeRole:fake.assumeRole,clientFrom:fake.clientFrom});
  const clientFor=leak === "shared-session"?()=>tagged(COMPANY_A.orgId):tagged;
  const writer=createSecretsManagerConnectionSecrets({env:"local",clientFor});
  const raw=SHARED_RAW_IDS.secretName;
  const relative=(company:string)=>`org-connectors/${company}/${raw}`;
  const full=(company:string)=>`agentx/local/${relative(company)}`;
  const adapter=createSecretsManagerSecretStore({namePrefix:"agentx/local/",clientFor:()=>fake.unrestricted(),...(leak === "name-check"?{}:{companyPaths:COMPANY_SECRET_PATHS,unscopedNamesBelongTo:IMPLICIT_COMPANY_ID})});
  const inner=new InMemoryConnectionSecrets("local");
  const bound=(company:string)=>memberBoundConnectionSecrets({companies:{companyOf:async()=>company},personId:"person",inner});
  const surfaces:IsolationSurface[]=[{
    kind:"secret",name:"S1 adapter names",
    async plant(me){fake.seed(full(me.orgId),me.canary,{"rovara:org":me.orgId});return {handle:relative(me.orgId)};},
    async observe(me,pair){return [ (await adapter.read(me.orgId,{awsSecret:pair.own as string}))?.reveal(), await attempt(async()=>(await adapter.read(me.orgId,{awsSecret:pair.other as string}))?.reveal()) ];},
  },{
    kind:"secret",name:"S2 membership connection put/read/delete",
    async plant(me){await bound(me.orgId).put(me.orgId,full(me.orgId),me.canary);return {handle:me.orgId};},
    async observe(me,pair){const store=bound(me.orgId);const other=pair.other as string;
      const own=await store.read(me.orgId,full(me.orgId));
      const crossed=await store.read(other,full(other));
      const write=await attempt(()=>store.put(other,full(other),"corruption"));const remove=await attempt(()=>store.scheduleDelete(other,full(other)));
      await store.scheduleDelete(me.orgId,full(me.orgId));return {own,crossed,write,remove,deleted:await store.read(me.orgId,full(me.orgId))};},
  },{
    kind:"secret",name:"S3 writer and tagged sessions",
    async plant(me){const name=full(me.orgId);
      if(leak === "untagged-writer") { const {CreateSecretCommand}=await import("@aws-sdk/client-secrets-manager");await (await clientFor(me.orgId)).send(new CreateSecretCommand({Name:name,SecretString:me.canary})); }
      else await writer.put(me.orgId,name,me.canary);return {handle:name};},
    async observe(me,pair){const own=await writer.read(me.orgId,pair.own as string);const cross=await writer.read(me.orgId,pair.other as string);return {own,cross};},
  },{
    kind:"secret",name:"S4 legacy name belongs only to implicit company",expectOwn:false,
    async plant(){fake.seed(raw,"legacy-marker",{});},
    async observe(me){const legacy=createSecretsManagerSecretStore({namePrefix:"",clientFor:()=>fake.unrestricted(),companyPaths:COMPANY_SECRET_PATHS,unscopedNamesBelongTo:IMPLICIT_COMPANY_ID});
      const other=await legacy.read(me.orgId,{awsSecret:raw});if(other!==undefined) throw new Error("legacy isolation failed");
      const own=await legacy.read(IMPLICIT_COMPANY_ID,{awsSecret:raw});if(own?.reveal()!=="legacy-marker")throw new Error("legacy control failed");return undefined;},
  }];
  const ledger=createCompanySecretStore();const ref={awsSecret:raw};
  return {surfaces,failClosed:[{
    name:"membership never falls back to implicit company",
    async prepare(){ledger.set(COMPANY_A.orgId,ref,COMPANY_A.canary);ledger.set(IMPLICIT_COMPANY_ID,ref,COMPANY_A.canary);},
    async attempt(mode){const companies={companyOf:async()=>{if(mode === "throws")throw new Error("unavailable");return undefined;}};
      if(leak === "fallback")return (await ledger.read(IMPLICIT_COMPANY_ID,ref))?.reveal();
      return (await createMemberSecretReader({companies,store:ledger}).readAs("person-a",ref))?.reveal();},
  }]};
}
