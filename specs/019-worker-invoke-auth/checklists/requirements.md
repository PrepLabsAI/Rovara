# Requirements Checklist: Worker Invoke Authentication

- [x] CHK001 Every rejection happens before the invocation is journaled; header failures before the body is read.
- [x] CHK002 The worker has no signing capability.
- [x] CHK003 AgentCore workers are unchanged.
- [x] CHK004 The ingress rule itself (#82) is out of scope.
