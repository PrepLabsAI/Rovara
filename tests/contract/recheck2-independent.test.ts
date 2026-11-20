import { expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped } from "@agentx/contracts";
import { identityHarness, OIDC_ISSUER } from "../support/developer-fakes.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { signinCompanyWorld } from "../support/signin-company-world.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

it.each([false, true].flatMap((explicit) => ["on", "off", "cutoff"].map(policy => ({explicit,policy}))))("independent install policy explicit=$explicit policy=$policy ignores all company resolvers", async ({explicit,policy}) => {
 const h = identityHarness({oidc:{}, oidcUsers:[{sub:"person", email:"shared@example.test",email_verified:true}]});
 const company = new CompanySignInStore({documentClient:h.db,tableName:"signin",now:h.now}); h.deps.company=company;
 await company.preapprove(IMPLICIT_COMPANY_ID,"shared@example.test","member",24);
 const resolver=vi.fn(async()=>({provider:h.deps.providers.oidc!,issuer:OIDC_ISSUER,since:0})); h.deps.companyIssuer=resolver;
 for(const id of [IMPLICIT_COMPANY_ID,COMPANY_A.orgId]) h.db.set({pk:companyScoped(id,"SIGNIN_ISSUER"),sk:"OIDC",entityType:"COMPANY_SIGNIN_ISSUER",issuer:OIDC_ISSUER,clientId:"other-company-client",displayName:"Other",requiredValues:[],enabled:true,enabledSince:0,since:0});
 const first=await h.signIn("oidc","person");
 if(explicit){const row=h.db.find(r=>r.entityType==="AUTH_CODE")[0]!;h.db.set({...row,companyId:IMPLICIT_COMPANY_ID});}
 const signed=await h.exchange(first.searchParams.get("code")!);expect(signed.status).toBe(200);
 const second=await h.signIn("oidc","person");
 if(explicit){const row=h.db.find(r=>r.entityType==="AUTH_CODE")[0]!;h.db.set({...row,companyId:IMPLICIT_COMPANY_ID});}
 if(policy==="off"){delete h.deps.config.oidc;delete h.deps.providers.oidc;}
 if(policy==="cutoff")h.deps.config.oidc!.since=h.now()/1000+10;
 expect((await h.exchange(second.searchParams.get("code")!)).status).toBe(policy==="off"?400:200);
 expect((await h.refresh(signed.body.refresh_token as string)).status).toBe(policy==="on"?200:400);
 expect(resolver).not.toHaveBeenCalled();
});

it.each(["missing","revoked","malformed","moved","read"])("independent code AND refresh refuse live membership %s", async damage=>{
 const h=signinCompanyWorld();await h.create(COMPANY_A.orgId);
 const first=await h.signInCompany(COMPANY_A.orgId);const signed=await h.exchange(new URL(first.headers.location!).searchParams.get("code")!);expect(signed.status).toBe(200);
 const second=await h.signInCompany(COMPANY_A.orgId);const code=new URL(second.headers.location!).searchParams.get("code")!;
 const member=h.db.find(r=>r.entityType==="COMPANY_MEMBERSHIP")[0]!;
 if(damage==="missing")h.db.delete(member.pk as string,member.sk as string);
 if(damage==="revoked")h.db.set({...member,revokedAt:new Date(h.now()).toISOString()});
 if(damage==="malformed")h.db.set({...member,companyId:"bad-company"});
 if(damage==="moved")h.db.set({...member,companyId:COMPANY_B.orgId});
 if(damage==="read")vi.spyOn(h.company,"membership").mockRejectedValue(new Error("private-canary"));
 const ended={status:400,body:{error:"invalid_grant",error_description:"your Rovara sign-in has ended; start signing in again"}};
 expect(await h.exchange(code)).toEqual(ended);expect(await h.refresh(signed.body.refresh_token as string)).toEqual(ended);
});
