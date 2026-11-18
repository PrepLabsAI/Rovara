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
import { gcpPackMirrorRepositories, testServiceMirrorRepositories } from "@agentx/contracts";

/** The worker's read of the copies: exactly these actions, on exactly the five repositories. */
export const TEST_SERVICE_MIRROR_READ_ACTIONS = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"] as const;
export const TEST_SERVICE_MIRROR_READ_SID = "TestServiceImageRead";

/**
 * L4-E8I (owner DEC 254zzz62): the GCP pack's own copies, three more repositories (Spanner, fake-gcs-server, the goccy BigQuery emulator: the images whose licence allows a copy) and the worker role's read of exactly those three, in a statement
 * of its own beside the five starters' (the starters' repositories, grant and the boot's `refs` are unchanged). Same settings as the starters (immutable tags, scan on push, AES256; but emptied and deleted with the stack, see below) plus a lifecycle rule that can
 * only ever remove the OLDEST of more than twenty TAGGED copies of the same repository: no rule touches an untagged image, so the platform images of a multi-platform copy (untagged in ECR) are never expired, and a pinned copy is only
 * evicted after twenty newer digests of the same image were copied. Google's SDK emulators image is NOT here and never will be: it is pulled from Google's registry at worker boot.
 */
export const GCP_PACK_MIRROR_READ_SID = "GcpPackImageRead";
export const GCP_PACK_MIRROR_KEEP_TAGGED = 20;
export const GCP_PACK_MIRROR_LIFECYCLE_POLICY = JSON.stringify({
  rules: [{
    rulePriority: 1,
    description: `Keep the newest ${GCP_PACK_MIRROR_KEEP_TAGGED} tagged copies; never touches an untagged (platform) image`,
    selection: { tagStatus: "tagged", tagPatternList: ["*"], countType: "imageCountMoreThan", countNumber: GCP_PACK_MIRROR_KEEP_TAGGED },
    action: { type: "expire" },
  }],
});

export interface TestServiceMirrorProps {
  env: string;
  /** The worker instance role, which gets the read statement. */
  workerRole: iam.Role;
}

export class TestServiceMirror extends Construct {
  /** The repositories' ARNs, in the starter list's order. */
  readonly repositoryArns: string[];
  /** The GCP pack's three repositories' ARNs, in the pack list's order. */
  readonly gcpPackRepositoryArns: string[];

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
    this.gcpPackRepositoryArns = gcpPackMirrorRepositories(props.env).map((mirror, index) => {
      new ecr.CfnRepository(this, `GcpPackRepository${index}`, {
        repositoryName: mirror.repositoryName,
        imageTagMutability: "IMMUTABLE",
        imageScanningConfiguration: { scanOnPush: true },
        encryptionConfiguration: { encryptionType: "AES256" },
        lifecyclePolicy: { lifecyclePolicyText: GCP_PACK_MIRROR_LIFECYCLE_POLICY },
        // NOT kept on a stack delete, unlike the starters' copies: these are straight copies of public images that the copy script remakes by digest, and a retained resource is one more line in the destroy inventory,
        // which is within a few bytes of SSM's 4096-byte limit for a 20-character environment (tests/contract/destroy-inventory-size.test.ts). So a delete empties the repository first (EmptyOnDelete).
        emptyOnDelete: true,
        tags: [{ key: "Purpose", value: "gcp-pack-image-copy" }, { key: "Family", value: mirror.image.family }],
      });
      return `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${mirror.repositoryName}`;
    });
    props.workerRole.addToPolicy(new iam.PolicyStatement({ sid: GCP_PACK_MIRROR_READ_SID, actions: [...TEST_SERVICE_MIRROR_READ_ACTIONS], resources: [...this.gcpPackRepositoryArns] }));
  }
}
