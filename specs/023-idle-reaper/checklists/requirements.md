# Requirements Checklist: EC2 Session Idle Reaper

- [x] CHK001 A dispatch or task racing a reap always wins.
- [x] CHK002 The workspace's status is never changed.
- [x] CHK003 The reaper terminates only this environment's ec2-ebs instances.
- [ ] CHK004 Idle stop observed in production.
