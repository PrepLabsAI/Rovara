# Plan

Add a safe ExtensionFailure callback to orchestrator and hosted runtime options. Bind Pi's onError after session creation inside createPiSessionRuntime's factory, before session-start handlers execute. Map extension paths only to configured inline names, bound event identifiers, and use unknown errorName; never inspect error text or stack. Independently guard logging and recording. Wire the hosted callback to its structured logger with Slack eventId.

Use the real SDK and faux model for deterministic lifecycle and hosted wiring tests. Run related integration/contract tests, typecheck and lint. No dependency or infrastructure changes. Constitution V requires evidence; tool boundaries and durable sessions remain as specified by I and IV.
