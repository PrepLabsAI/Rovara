# OpenRouter model access (#122)

## Confirmed behavior
Administrators enable Bedrock, OpenRouter, or both. Project-approved provider/model pairs remain the source of Slack worker selections; selection is project-wide and applies to subsequent tasks. Model choices display the provider. Orchestrator and classifier defaults are configured independently.

## Requirements
- FR-001: Use Pi's existing OpenRouter provider for worker, orchestrator and action classifier; preserve Bedrock defaults and mixed configurations.
- FR-002: Configure authentication by secret ARN, resolve credentials in memory, and never put keys in user data, sessions, project configuration or logs.
- FR-003: Validate model capabilities and use explicit routing settings with no implicit model escalation. Require supported parameters and disallow upstream data collection; document routing choices.
- FR-004: Extend init, deploy, worker boot and preflight. OpenRouter model checks must not call Bedrock.
- FR-005: Preserve project approval, streaming, tool calls, cancellation, resumption and model switching.
- FR-006: Report usage honestly, distinguish unknown/estimated cost, and identify requested and returned models when available.

## Verification
Automated configuration, runtime, transport and infrastructure tests; existing Bedrock regressions; opt-in live smoke using a supplied secret reference, models and budget. No live deployment or paid requests until these are supplied. Local tests do not establish live compatibility.

## Missing-secret behavior (user clarification)

When an OpenRouter secret reference is absent, the secret does not exist, or its value is empty,
resolve the default Bedrock model before opening the session. For workers, preserve a configured
Bedrock default; otherwise use the role's standard init default. Keep the requested project choice
unchanged and record the effective model in telemetry. This is an explicitly authorized exception
to the no-implicit-fallback policy. Access-denied, malformed credentials, transport failures and
rate limits do not trigger this fallback. Init permits an omitted ARN and preflights the fallback
Bedrock model when the OpenRouter secret is missing.
