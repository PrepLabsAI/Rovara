import {expect,it,vi} from "vitest";
import {createWorkerCallbackSinks} from "../../packages/worker/src/callback-client.js";
import {WorkerInvocationSchema} from "../../packages/contracts/src/protocol.js";
const binding={version:1 as const,stage:"build" as const,companyRevision:3,recipeDigest:"a".repeat(64)},model={provider:"amazon-bedrock" as const,modelId:"us.anthropic.claude-sonnet-4-6"};
const invocation=WorkerInvocationSchema.parse({protocolVersion:1,kind:"task",operationId:"11111111-1111-4111-8111-111111111111",workspaceId:"22222222-2222-4222-8222-222222222222",fence:1,projectRevision:1,callbackCapability:"c".repeat(40),payload:{conversationId:"33333333-3333-4333-8333-333333333333",prompt:"Fix",conversationStarted:false,model,modelPolicy:binding}});
it("posts only a bound fallback request on the operation capability and decodes the bound reply",async()=>{
 const fetchImplementation=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({version:1,binding,model,sourcesRevision:4,requestId:"request-meta"}),{status:200}));
 const sinks=createWorkerCallbackSinks({controlPlaneUrl:"https://broker.invalid",invocation,fetchImplementation});
 expect(await sinks.authorizeModelFallback({version:1,binding,reason:"unavailable",failedModel:model})).toMatchObject({binding,model,sourcesRevision:4});
 const [url,init]=fetchImplementation.mock.calls[0]!;expect(url).toBe(`https://broker.invalid/v1/internal/workspaces/${invocation.workspaceId}/operations/${invocation.operationId}/model-fallback`);const body=init?.body;if(typeof body!=="string")throw Error("expected JSON request body");expect(JSON.parse(body)).toEqual({version:1,binding,reason:"unavailable",failedModel:model});
});
it("refuses stale replies and HTTP denial instead of treating them as notification success",async()=>{
 for(const response of [()=>new Response(JSON.stringify({recorded:true}),{status:200}),()=>new Response(JSON.stringify({version:1,binding:{...binding,companyRevision:4},model,sourcesRevision:4}),{status:200}),()=>new Response("denied",{status:403})]){
  const sinks=createWorkerCallbackSinks({controlPlaneUrl:"https://broker.invalid",invocation,fetchImplementation:async()=>response()});
  await expect(sinks.authorizeModelFallback({version:1,binding,reason:"revoked",failedModel:model})).rejects.toThrow();
 }
});

it("refuses an outgoing request outside the invocation binding before posting",async()=>{
 const transport=vi.fn<typeof fetch>(async()=>new Response("{}",{status:200}));
 const sinks=createWorkerCallbackSinks({controlPlaneUrl:"https://broker.invalid",invocation,fetchImplementation:transport});
 await expect(sinks.authorizeModelFallback({version:1,binding:{...binding,companyRevision:4},reason:"revoked",failedModel:model})).rejects.toThrow("binding");
 expect(transport).not.toHaveBeenCalled();
});
it("builds session authorization from the broker binding and actual failed plan model",async()=>{
 const {taskFallbackAuthorizer}=await import("../../packages/worker/src/model-fallback-authority.js");
 const plan={provider:"openai",modelId:"gpt-6.1-sol"};
 const authorize=vi.fn(async()=>({version:1 as const,binding,model,sourcesRevision:4}));
 const run=taskFallbackAuthorizer({model,chatgpt:{model:plan},modelPolicy:binding},authorize);
 expect(run).toBeTypeOf("function");await run!("limit");
 expect(authorize).toHaveBeenCalledWith({version:1,binding,reason:"limit",failedModel:plan});
 expect(taskFallbackAuthorizer({model},authorize)).toBeUndefined();
});
it("relays missing-key candidate but uses only the broker-selected replacement",async()=>{
 const {taskMissingKeyAuthorizer}=await import("../../packages/worker/src/task-model.js");
 const approved={provider:"amazon-bedrock",modelId:"us.anthropic.claude-haiku-4-5-20251001-v1:0"};
 const authorize=vi.fn(async()=>({version:1 as const,binding,model:approved,sourcesRevision:4}));
 const run=taskMissingKeyAuthorizer({modelPolicy:binding},authorize,undefined,{});
 const result=await run!({role:"worker",reason:"openai_secret_missing",requested:{provider:"openai",modelId:"gpt-6.1-sol"},effective:model,text:"fixture"});
 expect(authorize).toHaveBeenCalledWith({version:1,binding,reason:"missing_key",failedModel:{provider:"openai",modelId:"gpt-6.1-sol"},environmentFallback:model});
 expect(result.model).toMatchObject(approved);
});
