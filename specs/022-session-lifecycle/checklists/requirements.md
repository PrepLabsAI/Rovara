# Requirements Checklist: EC2 Session Lifecycle

- [x] CHK001 Every transition is conditional on state and generation.
- [x] CHK002 A failed start fails its parked work instead of retrying forever.
- [x] CHK003 Destructive EC2 actions are limited to this environment's tagged resources.
- [x] CHK004 Production only gains resources; the foundation is unchanged.
- [ ] CHK005 End-to-end run passed against production.
