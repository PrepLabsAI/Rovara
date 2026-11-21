import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { grantKeyFor, projectMemberRowKeyFor } from "./company-layout.js";

/** Internal row construction only; the caller owns authorization and the transaction. */
export function buildDeveloperProjectGrantWrites(input: {
  tableName: string;
  project: string;
  developerId: string;
  companyId?: string;
  grantedBy: { issuer: string; subject: string };
  grantedAt: string;
  grantId: string;
}): NonNullable<TransactWriteCommandInput["TransactItems"]> {
  return [
    { Put: {
      TableName: input.tableName,
      Item: { ...grantKeyFor(input.companyId, input.developerId, input.project), entityType: "MEMBERSHIP", ownerKey: input.developerId,
        projectName: input.project, role: "developer", grantId: input.grantId, grantedBy: input.grantedBy, grantedAt: input.grantedAt },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
    { Put: { TableName: input.tableName,
      Item: { ...projectMemberRowKeyFor(input.companyId, input.project, input.developerId), entityType: "PROJECT_MEMBER", role: "developer", grantedAt: input.grantedAt },
    } },
  ];
}
