import {expect,it} from "vitest";
import {TaskModelFallbackRequestSchema,TaskModelPolicyBindingSchema,TaskModelFallbackAuthorizationSchema,WorkerInvocationSchema} from "../../packages/contracts/src/protocol.js";
const binding={version:1,stage:"build",companyRevision:3,recipeDigest:"a".repeat(64)};
const invocation={protocolVersion:1,kind:"task",operationId:"11111111-1111-4111-8111-111111111111",workspaceId:"22222222-2222-4222-8222-222222222222",fence:1,projectRevision:1,callbackCapability:"c".repeat(40),payload:{conversationId:"33333333-3333-4333-8333-333333333333",prompt:"Fix a bug",conversationStarted:false,model:{provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6"},modelPolicy:binding}};
it("strictly binds a governed worker operation to stage, policy revision and frozen recipe",()=>{
 expect(TaskModelPolicyBindingSchema.parse(binding)).toEqual(binding);
 for(const raw of [{...binding,stage:"check"},{...binding,companyRevision:-1},{...binding,recipeDigest:"bad"},{...binding,allowFallback:true}])expect(TaskModelPolicyBindingSchema.safeParse(raw).success).toBe(false);
 expect(WorkerInvocationSchema.parse(invocation)).toMatchObject({payload:{modelPolicy:binding}});
 expect(WorkerInvocationSchema.safeParse({...invocation,payload:{...invocation.payload,model:undefined}}).success).toBe(false);
});
it("requires a strict bound broker authorization and never accepts arbitrary callback flags",()=>{
 const reply={version:1,binding,model:invocation.payload.model,sourcesRevision:2};
 expect(TaskModelFallbackAuthorizationSchema.parse(reply)).toEqual(reply);
 for(const raw of [{recorded:true},{...reply,allowed:true},{...reply,model:{...reply.model,key:"forbidden"}},{...reply,sourcesRevision:-1}])expect(TaskModelFallbackAuthorizationSchema.safeParse(raw).success).toBe(false);
});

it("strictly limits callback reasons and environment candidate input",()=>{
 const request={version:1,binding,reason:"missing_key",failedModel:invocation.payload.model,environmentFallback:invocation.payload.model};
 expect(TaskModelFallbackRequestSchema.safeParse(request).success).toBe(true);
 for(const raw of [{...request,reason:"revoked"},{...request,allowed:true},{...request,reason:"custom_provider_text"}])expect(TaskModelFallbackRequestSchema.safeParse(raw).success).toBe(false);
});
