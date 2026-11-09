import {normalizeContext} from "@earendil-works/pi-ai";
import {expect,it,vi} from "vitest";
import {createWorkerChatGptFallback,type workerModelRuntime,type WorkspaceModelConfiguration} from "../../packages/worker/src/pi-session.js";
const initial={provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6"};
it("refuses a governed replacement stream when authority fails, even if stream is called directly",async()=>{
 const runtime=vi.fn(async()=>{throw Error("runtime must not start");}),report=vi.fn(),authorize=vi.fn(async()=>{throw Error("policy refused");});
 const fallback=createWorkerChatGptFallback(initial,report,undefined,authorize,runtime);
 await expect(fallback.authorize!("limit")).rejects.toThrow("policy refused");
 await expect(fallback.stream(normalizeContext({messages:[]}),undefined)).rejects.toThrow("authorization");
 expect(runtime).not.toHaveBeenCalled();expect(report).not.toHaveBeenCalled();
});
it("constructs the replacement only from the broker-authorized model and route",async()=>{
 const approved={model:{provider:"rovara-route",modelId:"approved-alias"},proxy:{baseUrl:"http://proxy.invalid",apiKey:async()=>"fixture-token",route:{alias:"approved-alias",api:"anthropic-messages" as const,catalog:"claude-sonnet-4-6"}}};
 const runtime=vi.fn(async(model:WorkspaceModelConfiguration)=>({runtime:{getModel:()=>undefined},model} as unknown as Awaited<ReturnType<typeof workerModelRuntime>>));
 const fallback=createWorkerChatGptFallback(initial,vi.fn(),undefined,async()=>approved,runtime);
 await fallback.authorize!("limit");
 await expect(fallback.stream(normalizeContext({messages:[]}),undefined)).rejects.toThrow("unavailable");
 expect(runtime).toHaveBeenCalledWith(approved.model,approved.proxy);
});
