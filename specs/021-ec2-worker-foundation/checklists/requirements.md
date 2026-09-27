# Requirements Checklist: EC2 Worker Foundation

- [x] CHK001 Production templates are unchanged; the 8080 ingress rule cannot reach production.
- [x] CHK002 Only the dispatcher can sign.
- [x] CHK003 Instance role has no AgentCore, KMS or SSM permissions.
- [ ] CHK004 Deployed to a non-production environment.
