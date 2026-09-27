# Tasks: Deliver Work to EC2 Workers

- [x] T001 ec2-ebs delivery, progress event, dispatcher routing; tests (`tests/contract/ec2-dispatch.test.ts`).
- [x] T002 Close completion deletes the ec2-ebs session; CLI registers ec2-ebs; tests.
- [x] T003 Dispatcher in the VPC, IAM, parameters; infrastructure tests; snapshots re-recorded.
- [x] T004 `ec2-test` registered as ec2-ebs and bound to `C0C4NKT8JAZ`; on 2026-09-27 a Slack thread ran prepare (2 min 13 s), a task, a task after the reaper's idle stop (resumed on the same volume, 2 min 15 s) and close (instance terminated, volume deleted).
