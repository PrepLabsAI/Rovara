// Port lane P5 (item K2): the `model-provider` plug-in point's adapters and helpers.
export * from "./builtin.js";
export { modelProviderPlugin } from "./plugin.js";
export { bedrockModelProvider, BEDROCK_PROVIDER_ID, BEDROCK_MESSAGES_CAPABILITIES, BEDROCK_CHAT_CAPABILITIES, type BedrockProviderOptions } from "./bedrock/index.js";
export { bedrockModelProviderPlugin, type BedrockPluginOptions } from "./bedrock/plugin.js";
