// DEC 254zm: the install's own copies of the test-service starter images (packages/contracts/src/test-service-mirror.ts), named environments only.
//
// Five ECR repositories, one per starter image, holding a copy made BY DIGEST (scripts/test-services-mirror.ts): the digest is the identity, a tag is a label. Each repository:
//   - IMMUTABLE tags (a tag never moves to other bytes), scan on push, AES256 encryption;
//   - NO lifecycle rule: a copy is immutable and pinned, so nothing may expire it (a count rule could evict the pinned copy, and an untagged rule would delete the platform images of a multi-platform copy,
//     which are untagged in ECR). A starter whose digest changes in a release gets a new copy beside the old; the old one is removed by hand once no release names it;
//   - kept when the stack is deleted (the copies outlive a stack; RetainExceptOnCreate cleans up a failed first create).
// The worker role reads them and nothing else is granted here: GetDownloadUrlForLayer, BatchGetImage and BatchCheckLayerAvailability on exactly these five repository ARNs (ECR's login token,
// GetAuthorizationToken on *, which ECR requires, is the worker's existing EcrTokenAccess statement). No push, no delete. The names are outside the environment's pull-through prefix (`agentx-<env>/`), so the worker
// role's EcrPullThroughCache statement (BatchImportUpstreamImage, CreateRepository on repository/agentx-<env>/*) does not reach them.
import { Aws, RemovalPolicy, aws_ecr as ecr, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";
import { testServiceMirrorRepositories } from "@agentx/contracts";

/** The worker's read of the copies: exactly these actions, on exactly the five repositories. */
export const TEST_SERVICE_MIRROR_READ_ACTIONS = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"] as const;
export const TEST_SERVICE_MIRROR_READ_SID = "TestServiceImageRead";

export interface TestServiceMirrorProps {
  env: string;
  /** The worker instance role, which gets the read statement. */
  workerRole: iam.Role;
}

export class TestServiceMirror extends Construct {
  /** The repositories' ARNs, in the starter list's order. */
  readonly repositoryArns: string[];

  constructor(scope: Construct, id: string, props: TestServiceMirrorProps) {
    super(scope, id);
    this.repositoryArns = testServiceMirrorRepositories(props.env).map((mirror, index) => {
      const repository = new ecr.CfnRepository(this, `Repository${index}`, {
        repositoryName: mirror.repositoryName,
        imageTagMutability: "IMMUTABLE",
        imageScanningConfiguration: { scanOnPush: true },
        encryptionConfiguration: { encryptionType: "AES256" },
        tags: [{ key: "Purpose", value: "test-service-starter-copy" }, { key: "Starter", value: mirror.starter.requested.replace(":", "-") }],
      });
      repository.applyRemovalPolicy(RemovalPolicy.RETAIN);
      return `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${mirror.repositoryName}`;
    });
    props.workerRole.addToPolicy(new iam.PolicyStatement({ sid: TEST_SERVICE_MIRROR_READ_SID, actions: [...TEST_SERVICE_MIRROR_READ_ACTIONS], resources: [...this.repositoryArns] }));
  }
}
