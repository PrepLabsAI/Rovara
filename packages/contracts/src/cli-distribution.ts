// Display and distribution identity only. Existing configuration, resources and MCP tool IDs
// retain their AgentX identities. pack-cli embeds the actual package name when --name overrides it.
declare const __AGENTX_NPM_PACKAGE__: string | undefined;

export const DEFAULT_CLI_PACKAGE_NAME = "@preplabsai/rovara-code";
export const CLI_PACKAGE_NAME = typeof __AGENTX_NPM_PACKAGE__ === "string"
  ? __AGENTX_NPM_PACKAGE__
  : DEFAULT_CLI_PACKAGE_NAME;
export const CLI_COMMAND_NAME = "rovara";
