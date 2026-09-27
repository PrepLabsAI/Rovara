# Requirements Checklist: EC2 Session Idle Reaper

- [x] CHK001 A dispatch or task racing a reap always wins.
- [x] CHK002 The workspace's status is never changed.
- [x] CHK003 The reaper terminates only this environment's ec2-ebs instances.
- [x] CHK004 Idle stop observed in production (2026-09-27).
