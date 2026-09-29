// SC-005: the day-2 commands run under the operator role alone. Each command declares the AWS
// actions it uses; every one must already be allowed by the operator role's policy. This checks
// hand-kept lists, not the calls made: Task 20's policy simulator run is the real proof (ruling F13).
import { describe, expect, it } from "vitest";
import { operatorRoleStatements } from "@agentx/contracts";
import { DOCTOR_AWS_ACTIONS } from "../../packages/cli/src/day-two-actions.js";

const scope = {
  env: "staging", partition: "aws", region: "us-east-1", account: "123456789012",
  artifactBucketArn: "arn:aws:s3:::agentx-staging-access-artifactbucket", pullThroughPrefix: "agentx-staging", cloudFormationRoleName: "agentx-staging-cloudformation",
};
const allowed = new Set(operatorRoleStatements(scope).filter((statement) => statement.Effect === "Allow").flatMap((statement) => statement.Action));

describe("doctor needs no permission beyond the operator role (SC-005)", () => {
  it.each(DOCTOR_AWS_ACTIONS.map((action) => [action]))("doctor: %s is allowed", (action) => {
    expect(allowed.has(action)).toBe(true);
  });
});
