# Plan

Add a small shared model-runtime package wrapping Pi configuration and Secrets Manager resolution. Keep runtime keys in an in-memory credential store. Register OpenRouter models from the pinned Pi catalog, using its OpenAI-compatible transport with explicit routing and sanitized transport failures. Reuse existing project model pairs.

Extend install model answers with optional per-role providers and an OpenRouter secret reference, preserving legacy answers. Carry references via CloudFormation, SSM and boot configuration; grant read access to only the configured secret. Add provider-aware setup checks and documentation. Keep the existing Bedrock adapter for workers.

Constitution: credentials remain outside model context, orchestration tools remain restricted, session continuity and operation deduplication remain intact. No additional agent framework or gateway service.

User clarification: add a model-runtime resolver that catches only typed missing-secret results
and returns the role's default Bedrock model and runtime before creating a session. Preserve
requested project selection, use the effective model for usage, and log the fallback. Init allows
missing ARN configuration and checks the corresponding Bedrock fallback. Do not fall back for
permission or inference failures. Share standard role defaults with init.

PR review correction: keep the protected foundation unchanged. Attach the conditional secret-read
policy to both Slack and worker roles from the releasable control-plane stack; derive the worker
role name from its existing ARN output with the foundation's legacy/named role path. Trim secret
values before validation. Three application stacks still carry the secret reference for manual
change sets; document alignment and workspace/IMDS credential exposure with mandatory key limits.

Share the Sonnet 4.6 worker default across runtime fallback, interactive init and CLI export
flags. Update default expectations and documentation; verify init/export, runtime fallback and
explicit overrides with existing automated coverage. Existing deployments retain their configured models.
