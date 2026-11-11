// Port lane L2: the adapters and routing for the code-host, tracker and check-runner plug-in points. The registry itself is `../ports/adapter-registry.ts`.
// The GitHub client types in `code-host/github/provider.ts` are not re-exported here: their names are the ones `github-app.ts` already exports.
export * from "./routing.js";
export { contextSecretReader, readPluginSettings, secretReader, SecretSourceSchema, type SecretSource } from "./module-support.js";
export { githubCodeHost, GITHUB_CODE_HOST_CAPABILITIES, GITHUB_HOST_KIND, type GitHubCodeHostOptions } from "./code-host/github/index.js";
export { githubCodeHostPlugin, type GitHubCodeHostPluginOptions } from "./code-host/github/plugin.js";
export { GITHUB_CODE_HOST_PROVIDER_METHODS, missingGitHubProviderMethods, type GitHubCodeHostProvider, type GitHubActionsProvider } from "./code-host/github/provider.js";
export { githubActionsCheckRunner, GITHUB_ACTIONS_CAPABILITIES, GITHUB_ACTIONS_RUNNER_KIND } from "./check-runner/github-actions/index.js";
export { githubActionsPlugin, type GitHubActionsPluginOptions } from "./check-runner/github-actions/plugin.js";
export { codeBuildCheckRunner, checkOfBuild, CODEBUILD_CAPABILITIES, CODEBUILD_RUNNER_KIND, type CodeBuildRunnerOptions } from "./check-runner/codebuild/index.js";
export { codeBuildPlugin, type CodeBuildPluginOptions } from "./check-runner/codebuild/plugin.js";
export { linearTracker, LINEAR_TRACKER_KIND, type LinearTrackerAccess, type LinearIssueRead, type LinearReplyPort } from "./tracker/linear/index.js";
export { linearTrackerPlugin, type LinearTrackerPluginOptions } from "./tracker/linear/plugin.js";
export { createLinearApiAccess, linearCommentIdFor, workspaceOfIssueUrl, type LinearApiOptions } from "./tracker/linear/api.js";
export { jiraTracker, jiraSiteOf, JIRA_TRACKER_KIND, type JiraApiOptions } from "./tracker/jira/index.js";
export { jiraTrackerPlugin, type JiraTrackerPluginOptions } from "./tracker/jira/plugin.js";
// The fakes are not exported here: their webhook secrets are public constants, so a production build must not be able to enable one by accident. Tests import `./fake/` by path.
// Port lane P5 (item K2): the model-provider plug-in point (built-in rows, the helper that makes a module, Bedrock).
export * from "./model-provider/index.js";
// Owner decision 58: the chat tool's channel adapter, a plug-in like the others. Its module for a config entry is `@agentx/broker/plugins/channel-slack`.
export { SlackChannel, slackChannelPlugin, SLACK_CHANNEL_NAME, SLACK_CAPABILITIES, type SlackChannelOptions, type SlackChannelPluginOptions } from "./channel/slack/index.js";
