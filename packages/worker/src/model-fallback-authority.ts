import {TaskModelFallbackRequestSchema,TaskModelFallbackAuthorizationSchema,TaskModelPolicyBindingSchema,agentXError,type ModelSelection,type TaskModelFallbackRequest,type TaskModelFallbackAuthorization,type TaskModelPolicyBinding} from "@agentx/contracts";
/** A legacy notification response or a stale binding never authorizes a governed replacement. */
export function parseTaskModelFallbackAuthorization(raw:unknown,expected:TaskModelPolicyBinding):TaskModelFallbackAuthorization {
 const reply=TaskModelFallbackAuthorizationSchema.safeParse(raw),binding=TaskModelPolicyBindingSchema.safeParse(expected);
 if(!reply.success||!binding.success||reply.data.binding.version!==binding.data.version||reply.data.binding.stage!==binding.data.stage||reply.data.binding.companyRevision!==binding.data.companyRevision||reply.data.binding.recipeDigest!==binding.data.recipeDigest)throw agentXError("RUNTIME_UNAVAILABLE","The task's fallback authorization could not be verified.");
 return reply.data;
}

export function taskModelPolicyBindingsMatch(a:TaskModelPolicyBinding,b:TaskModelPolicyBinding):boolean {
 const left=TaskModelPolicyBindingSchema.safeParse(a),right=TaskModelPolicyBindingSchema.safeParse(b);
 return left.success&&right.success&&left.data.version===right.data.version&&left.data.stage===right.data.stage&&left.data.companyRevision===right.data.companyRevision&&left.data.recipeDigest===right.data.recipeDigest;
}

/** Relay for governed initial/mid-session failures; legacy invocations retain existing behavior. */
export function taskFallbackAuthorizer(payload:{model?:ModelSelection|undefined;chatgpt?:{model:ModelSelection}|undefined;modelPolicy?:TaskModelPolicyBinding|undefined},authorize:(request:TaskModelFallbackRequest)=>Promise<TaskModelFallbackAuthorization>) {
 if(payload.modelPolicy===undefined)return undefined;
 const binding=TaskModelPolicyBindingSchema.parse(payload.modelPolicy),failedModel=payload.chatgpt?.model??payload.model;
 if(failedModel===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The task's resolved model is unavailable.");
 return async(reason:TaskModelFallbackRequest["reason"])=>authorize(TaskModelFallbackRequestSchema.parse({version:1,binding,reason,failedModel:{provider:failedModel.provider,modelId:failedModel.modelId}}));
}
