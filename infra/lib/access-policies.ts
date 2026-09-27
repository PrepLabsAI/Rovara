// The two access-stack policy documents (and the pure helpers around them) now live in
// packages/contracts/src/access-policies.ts: phase 15c2's export bundle needs them from the CLI
// package, which may import @agentx/contracts but not infra/. This file re-exports them so every
// existing infra import (access.ts, role-path.ts, permissions-boundary.ts) and every existing test
// (access-policies.test.ts, access-stack.test.ts, environment-naming.test.ts) keeps working
// unchanged.
export {
  BOUNDARY_SERVICES,
  SERVICE_ROLE_SERVICES,
  defaultBoundaryArn,
  defaultBoundaryName,
  defaultBoundaryStatements,
  environmentRolePath,
  operatorRoleStatements,
  serviceRoleStatements,
  type PolicyScope,
  type PolicyStatementJson,
} from "@agentx/contracts";
