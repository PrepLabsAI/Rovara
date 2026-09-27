# Plan

Add a small shared model-runtime package wrapping Pi configuration and Secrets Manager resolution. Keep runtime keys in an in-memory credential store. Register OpenRouter models from the pinned Pi catalog, using its OpenAI-compatible transport with explicit routing and sanitized transport failures. Reuse existing project model pairs.

Extend install model answers with optional per-role providers and an OpenRouter secret reference, preserving legacy answers. Carry references via CloudFormation, SSM and boot configuration; grant read access to only the configured secret. Add provider-aware setup checks and documentation. Keep the existing Bedrock adapter for workers.

Constitution: credentials remain outside model context, orchestration tools remain restricted, session continuity and operation deduplication remain intact. No additional agent framework or gateway service.

User clarification: add a model-runtime resolver that catches only typed missing-secret results
and returns the role's default Bedrock model and runtime before creating a session. Preserve
requested project selection, use the effective model for usage, and log the fallback. Init allows
missing ARN configuration and checks the corresponding Bedrock fallback. Do not fall back for
permission or inference failures. Share standard role defaults with init.
