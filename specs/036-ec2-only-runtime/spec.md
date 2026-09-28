# EC2-only runtime (#119)

All installs, including self-hosted and `agentx init`, accept only `ec2-ebs` for new registration
and execution. User confirmed the scope decision from #99 on 2026-09-27.

Remove AgentCore dispatch, SDK dependencies, naming, drain scripts, prerequisites and active docs.
Keep closed workspace, operation and historical project revision reads compatible. Never dispatch
legacy outbox records to EC2 or reopen retired workspace compute.

Acceptance: `git grep -i agentcore` matches only specs history; build, lint and full tests pass.
