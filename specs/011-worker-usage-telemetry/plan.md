# Implementation Plan: Worker Usage Telemetry

**Branch**: `feature/025-usage-telemetry` | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)

## Summary

Expose Pi session statistics through the worker session adapter, create one bounded redacted usage payload after every task outcome, publish it through the existing event and artifact callbacks, and parameterize the production runtime's prompt-cache retention with a `long` default.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node.js 22
**Primary Dependencies**: `@earendil-works/pi-coding-agent` 0.85.1, AWS CDK v2, Vitest
**Storage**: Existing operation event records and private artifact bucket
**Testing**: Worker integration tests, broker contract tests, infrastructure assertions, full repository gates
**Constraints**: Public Pi exports only; no new price table; preserve original failure/cancellation; rolling compatibility

## Constitution Check

- **I — Orchestration-only clients**: PASS. Measurement occurs in the remote worker and uses existing control-plane callbacks.
- **II — Administrator-prepared projects**: PASS. No project definition or preparation behavior changes.
- **III — Shared definitions, isolated instances**: PASS. Usage attaches to the owning operation and private artifact scope.
- **IV — Durable working state**: PASS. Telemetry does not alter workspace ownership, fencing, or files.
- **V — Evidence-based delivery**: PASS. Success, failure, cancellation, redaction, compatibility, and synthesized configuration are tested.

## Design

1. Extend `PiSessionHandle` with the public `SessionStats` accessor and delegate to the live Pi session.
2. Resolve the effective cache-retention mode using Pi's exact fallback rule: only `long` selects long retention.
3. Build a schema-versioned usage payload after the task outcome is known. Calculate cache-read ratio with a zero-safe denominator.
4. Append the payload as a `usage` event and publish the same redacted JSON as `usage.json` before the final event flush.
5. Preserve an original task error or cancellation if telemetry publication also fails; telemetry failure fails an otherwise successful task.
6. Keep broker event validation open to string event names and prove `usage` reaches storage.
7. Add a constrained `PromptCacheRetention` production-runtime parameter and map it to `PI_CACHE_RETENTION`.

## Deployment Compatibility

The broker already accepts arbitrary string event types, so the worker may deploy first. The new runtime parameter defaults to `long`; existing deployment commands need no new argument. Older worker images ignore the environment variable.

## Complexity Tracking

No new service or datastore is introduced. Event and artifact delivery reuse the current authenticated, operation-scoped callback paths.
