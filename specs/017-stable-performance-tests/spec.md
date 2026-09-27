# Feature Specification: Stable Performance Tests

**Feature Branch**: `fix/059-stable-timing-tests`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #59

## User Scenario

### CI distinguishes complexity regressions from shared-runner contention (Priority: P1)

A maintainer can trust a redaction performance failure to indicate worsening input scaling rather
than a temporarily busy runner. CDK tests that legitimately synthesize and bundle Lambda assets
also receive enough test-local time to finish under full-suite contention.

**Independent Test**: Run the affected contract files repeatedly and as part of the full suite.

## Requirements

- **FR-001**: The `redactArguments` test MUST compare work at two input sizes and enforce a bounded scaling ratio.
- **FR-002**: The comparison MUST use repeated paired samples and a robust aggregate so one scheduling pause does not decide the result.
- **FR-003**: The test MUST still fail for quadratic growth; replacing the old assertion with a larger absolute timeout is insufficient.
- **FR-004**: Only CDK tests known to perform asset bundling MUST receive an extended timeout.
- **FR-005**: Production behavior MUST remain unchanged.

## Success Criteria

- **SC-001**: The scaling test passes under concurrent full-suite load and rejects a median doubling ratio of 3.25 or greater.
- **SC-002**: The two reported CDK packaging tests have a 30-second local timeout while the global 10-second timeout remains unchanged.
- **SC-003**: Typecheck, lint, the affected files, and the complete suite pass.
