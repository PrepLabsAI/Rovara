# Requirements Checklist: EC2 Worker Boot Script

- [x] CHK001 No path formats a volume unless it is blank and expected to be new.
- [x] CHK002 Every rendered value is validated against shell injection.
- [x] CHK003 The worker cannot start on the root volume after a reboot.
- [ ] CHK004 Verified on a real arm64 instance (after #82).
