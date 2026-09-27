# Tasks: EC2 Session Contracts

- [x] T001 Add `ec2-ebs` and the per-mode workspace shape to `packages/contracts/src/workspace.ts`.
- [x] T002 Add the EC2 runtime binding, `SESSION` record, session key and invoke-token claims in `packages/contracts/src/session.ts`.
- [x] T003 Make `RuntimeBinding` and `DurableOutboxRecord` per-mode unions and add `WAITING_FOR_SESSION` in `packages/broker/src/aws/lambda.ts`.
- [x] T004 Handle `ec2-ebs` in `parseRuntimeBinding`, workspace creation, `outboxRecord`, stop, close completion and the dispatcher.
- [x] T005 Handle `ec2-ebs` in the local lifecycle and preparation paths and in CLI registration.
- [x] T006 Add `tests/contract/ec2-session-contracts.test.ts`.
- [x] T007 Run typecheck, lint and the full suite; confirm convergence against #79.
