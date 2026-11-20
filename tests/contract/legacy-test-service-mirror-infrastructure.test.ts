import { beforeAll, describe, expect, it } from "vitest";
import { testServiceMirrorRepositories } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { TEST_SERVICE_MIRROR_READ_ACTIONS, TEST_SERVICE_MIRROR_READ_SID } from "../../infra/lib/test-service-mirror.js";

// #1159: production (the legacy template) holds its own copies of the test-service starter images, as a named environment does: the five ECR repositories under
// agentx-production--test-services/, in AgentXProductionFoundation (where the worker role lives), and the worker role's read of exactly those. The worker's boot stage reads the
// environment from its log group, /agentx/production/worker, so it pulls these names.

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
interface Template { Resources: Record<string, Resource> }
type Statement = { Sid?: string; Action: string | string[]; Resource: unknown };

describe("the test-service starter-image mirror in the legacy (production) template (#1159)", () => {
  let template: Template;
  beforeAll(() => { template = buildAgentXApp().synth().getStackByName("AgentXProductionFoundation").template as Template; }, 300_000);

  it("has the five repositories under production's names, immutable, scanned and kept on delete", () => {
    const repositories = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ECR::Repository" && String(resource.Properties.RepositoryName).includes("--test-services/"));
    expect(repositories.map((repository) => repository.Properties.RepositoryName).sort()).toEqual(testServiceMirrorRepositories("production").map((mirror) => mirror.repositoryName).sort());
    for (const repository of repositories) {
      expect(String(repository.Properties.RepositoryName)).toMatch(/^agentx-production--test-services\//u);
      expect(repository.Properties).toMatchObject({ ImageTagMutability: "IMMUTABLE", ImageScanningConfiguration: { ScanOnPush: true } });
      expect(repository.DeletionPolicy).toBe("Retain");
    }
    expect(JSON.stringify(template)).not.toContain("agentx-undefined");
  });

  it("lets the worker role read exactly those repositories, and nothing more", () => {
    const statements = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy")
      .flatMap((policy) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
      .filter((statement) => statement.Sid === TEST_SERVICE_MIRROR_READ_SID);
    expect(statements).toHaveLength(1);
    expect([statements[0]!.Action].flat().sort()).toEqual([...TEST_SERVICE_MIRROR_READ_ACTIONS].sort());
    const resources = JSON.stringify(statements[0]!.Resource);
    for (const mirror of testServiceMirrorRepositories("production")) expect(resources).toContain(`:repository/${mirror.repositoryName}`);
  });
});
