# Extension handler failure reporting (#47)

- FR-001: Capture Pi extension handler failures in initial and recreated orchestrator sessions, including session-start events.
- FR-002: Emit `extension.handler_failed` through the hosted service logger with event correlation and safe extension/event identifiers. Never emit raw messages, stack traces or arbitrary paths. Pi lacks a structured error class; report `unknown`.
- FR-003: When available, record `handler_failed:<extension>:<event>` through the existing bounded turn recordingErrors collection.
- FR-004: Log without a recorder; failures in either reporting sink must not prevent the other sink or escape into Pi.
- FR-005: Preserve orchestration boundaries and Pi's existing handler failure behavior; initialize once per session.

Acceptance: real Pi tests trigger failures and verify safe logging, recording, no duplicate initialization, recreation/resume, missing recorder and failing sinks. Existing orchestration and gate tests remain green.
