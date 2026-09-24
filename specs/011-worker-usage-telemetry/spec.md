# Feature Specification: Worker Usage Telemetry

**Feature Branch**: `feature/025-usage-telemetry`

**Created**: 2026-09-24

**Status**: Implemented and validated locally; deployment pending

**Input**: Issue #25: report per-task token usage and extend Bedrock prompt-cache retention.

## User Scenarios & Testing

### User Story 1 - Measure every coding task (Priority: P1)

An operator can inspect the model usage and estimated cost of each coding task next to its existing operation evidence, including tasks that fail or are cancelled.

**Independent Test**: Run successful, failed, and cancelled task fixtures and verify each publishes one redacted usage event and one matching private usage artifact.

**Acceptance Scenarios**:

1. **Given** a successful coding task, **When** the Pi session finishes, **Then** AgentX records its model, retention mode, token breakdown, cache-read ratio, cost estimate, and successful outcome.
2. **Given** a task fails after consuming model tokens, **When** failure handling runs, **Then** AgentX records the accumulated usage with a failed outcome before reporting the task failure.
3. **Given** a task is cancelled after consuming model tokens, **When** cancellation handling runs, **Then** AgentX records the accumulated usage with a cancelled outcome.
4. **Given** a new usage event reaches either control-plane implementation, **When** it is stored, **Then** existing consumers continue to accept and return the event without requiring a closed event-type schema.

### User Story 2 - Preserve prompt caches across human reply gaps (Priority: P2)

An operator can configure the production worker to use the one-hour Bedrock prompt-cache retention mode without rebuilding its image, and each usage record identifies the active mode.

**Independent Test**: Synthesize the production runtime and verify a constrained CloudFormation parameter with default `long` populates `PI_CACHE_RETENTION`; run worker fixtures for both retention modes and verify telemetry matches configuration.

**Acceptance Scenarios**:

1. **Given** the production runtime uses its default configuration, **When** it is deployed, **Then** `PI_CACHE_RETENTION` is `long`.
2. **Given** an operator selects a supported retention mode, **When** the stack is updated, **Then** the runtime receives that mode without an image rebuild.
3. **Given** an unset or unsupported worker environment value, **When** a task runs, **Then** telemetry reports the same `short` fallback used by Pi.

### Edge Cases

- A session reports zero input tokens; the cache-read ratio remains finite and is reported as zero.
- Artifact or event publication fails while the task itself also fails; the original task error remains authoritative.
- Usage fields contain credential-shaped text through provider or model configuration; both outputs redact it.
- A worker and control plane roll out in either order; old events remain valid and the new event type is accepted as a string.

## Requirements

### Functional Requirements

- **FR-001**: The worker MUST read session statistics through the public `@earendil-works/pi-coding-agent` package export.
- **FR-002**: Each task MUST publish exactly one `usage` event containing schema version, outcome, provider, model ID, cache-retention mode, input/output/cache-read/cache-write/total token counts, cache-read ratio, and estimated cost in USD.
- **FR-003**: The worker MUST publish the same usage payload as a private `usage.json` artifact.
- **FR-004**: Usage MUST be captured for successful, failed, and cancelled tasks after all accumulated session activity.
- **FR-005**: Usage events and artifacts MUST pass through existing credential redaction.
- **FR-006**: A telemetry publication failure MUST NOT replace an already-established task failure or cancellation result.
- **FR-007**: The control plane MUST accept and retain the new event type without narrowing existing string-based event contracts.
- **FR-008**: The production runtime MUST expose a CloudFormation parameter named `PromptCacheRetention` whose allowed values are `short` and `long`, defaulting to `long`.
- **FR-009**: The production runtime MUST set `PI_CACHE_RETENTION` from that parameter.
- **FR-010**: Usage telemetry MUST report `long` only when the configured environment value is exactly `long`; otherwise it MUST report `short`, matching Pi's fallback.
- **FR-011**: The implementation MUST NOT deep-import internal Pi modules or maintain a separate model price table.

## Success Criteria

- **SC-001**: Automated successful, failed, and cancelled task scenarios each produce one usage event and one matching usage artifact.
- **SC-002**: Token totals, cache-read ratio, model attribution, retention mode, and cost values match fixture session statistics exactly.
- **SC-003**: A credential-shaped fixture value appears redacted in both outputs.
- **SC-004**: Infrastructure synthesis proves `PI_CACHE_RETENTION` is parameterized with default `long` and only two supported values.
- **SC-005**: Type checking, linting, tests, and infrastructure synthesis pass.

## Assumptions

- Pi's `SessionStats.cost` is the available estimate and may understate one-hour cache-write cost; the retention mode makes that limitation explicit for downstream analysis.
- Cache-read ratio is cache-read tokens divided by input, cache-read, and cache-write tokens; a zero denominator yields zero.
- Prompt-cache retention materially improves follow-up turns only after conversation continuity from Issue #1 is implemented.
