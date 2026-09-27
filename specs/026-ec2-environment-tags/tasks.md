# Tasks

- [x] T001 Add regression coverage for named and unnamed EC2 instance and volume tags.
- [x] T002 Add environment tags and wire the environment into provisioner definitions.
- [x] T003 Run targeted contract tests, typecheck and lint; assess convergence.

## Validation
The new named-environment definition tests failed before the fix (2 failed, 9 passed).
After the fix, session-state-machines, ec2-worker-infrastructure and session-lifecycle-infrastructure contract suites passed (30 tests). Typecheck and lint passed. These are local synthesis checks, not live AWS verification.
