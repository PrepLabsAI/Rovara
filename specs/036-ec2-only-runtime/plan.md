# Implementation plan

Separate accepted deployment modes from stored historical modes. Retain legacy routing fields
only for record reads. Reject retired project bindings at registration and workspace allocation,
and retired workspace/outbox execution at the dispatch boundary.

Use EC2 quota checks for installation. Keep model inference on Bedrock unchanged. Update active
docs and fixtures to the EC2 lifecycle; add tests for historical reads and rejected legacy work.

Constitution: update runtime scope to EC2-only (3.0.0); no infrastructure deployment in this task.
