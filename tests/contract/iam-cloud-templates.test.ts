// L4: `npm run iam:validate` also takes SYNTHESIZED Cloud templates (this repository holds no Cloud code: a Cloud build step writes the cdk.out directories). Here: the input contract (a cdk.out
// manifest, nested templates, a flat directory, the failures for an empty or wrong directory), the boundary rule (every IAM role carries a permissions boundary), and the command line end to end
// with `--local-only` (no AWS).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boundaryProblems, loadCloudStacks, type CloudTemplate } from "../../scripts/iam-cloud-templates.js";
import { extractPolicyDocuments, serviceFieldProblems } from "../../scripts/validate-iam-policies.js";

const root = mkdtempSync(join(tmpdir(), "iam-cloud-templates-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
const boundaryPolicy = { Type: "AWS::IAM::ManagedPolicy", Properties: { PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "logs:*", Resource: "*" }] } } };
const role = (extra: Record<string, unknown> = {}) => ({ Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: trust, PermissionsBoundary: { Ref: "RoleBoundary" }, ...extra } });
/** A stack the way Cloud's aspect leaves it: one boundary policy, every role pointing at it. */
const good: CloudTemplate = { Resources: { RoleBoundary: boundaryPolicy, ServerRole: role(), BucketDeploymentRole: role() } };

function writeAssembly(name: string, templates: Record<string, CloudTemplate>, listed = true): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const artifacts: Record<string, unknown> = {};
  for (const [file, template] of Object.entries(templates)) {
    writeFileSync(join(directory, file), JSON.stringify(template));
    if (listed && !file.endsWith(".nested.template.json")) artifacts[file.replace(".template.json", "")] = { type: "aws:cloudformation:stack", properties: { templateFile: file, stackName: file.replace(".template.json", "") } };
  }
  if (listed) writeFileSync(join(directory, "manifest.json"), JSON.stringify({ version: "1", artifacts: { Tree: { type: "cdk:tree" }, ...artifacts } }));
  return directory;
}

describe("loadCloudStacks (the input contract)", () => {
  it("reads the stacks a cdk.out manifest names, by stack name, and the nested-stack templates the manifest does not list", () => {
    const directory = writeAssembly("assembly", { "cloudapp-web.template.json": good, "cloudapp-app.template.json": good, "Nested1234.nested.template.json": good });
    expect(loadCloudStacks(directory).map((stack) => stack.stackName).sort()).toEqual(["Nested1234.nested", "cloudapp-app", "cloudapp-web"]);
  });

  it("reads a directory without a manifest as flat *.template.json files", () => {
    const directory = writeAssembly("flat", { "one.template.json": good, "two.template.json": good }, false);
    expect(loadCloudStacks(directory).map((stack) => stack.stackName).sort()).toEqual(["one", "two"]);
  });

  it("fails on a directory that is missing or holds no template, never an empty pass", () => {
    mkdirSync(join(root, "empty"));
    expect(() => loadCloudStacks(join(root, "empty"))).toThrow(/no Cloud stack template/u);
    expect(() => loadCloudStacks(join(root, "does-not-exist"))).toThrow(/does not exist/u);
  });
});

describe("boundaryProblems (every role carries the permissions boundary)", () => {
  const stack = (resources: NonNullable<CloudTemplate["Resources"]>) => [{ stackName: "s", template: { Resources: resources } }];

  it("accepts roles that Ref the stack's boundary policy, an ARN string, Fn::Sub, Fn::Join and an import", () => {
    const arn = "arn:aws:iam::111122223333:policy/cloud/staging/boundary";
    expect(boundaryProblems(stack({
      RoleBoundary: boundaryPolicy, A: role(), B: role({ PermissionsBoundary: arn }),
      C: role({ PermissionsBoundary: { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/x" } }),
      D: role({ PermissionsBoundary: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::1:policy/x"]] } }),
      E: role({ PermissionsBoundary: { "Fn::ImportValue": "boundary-arn" } }),
    }))).toEqual([]);
  });

  it("names every role without a boundary, with a boundary that is not a policy, or with one that is attached to a role", () => {
    expect(boundaryProblems(stack({
      RoleBoundary: boundaryPolicy,
      None: role({ PermissionsBoundary: undefined }),
      NotAPolicy: role({ PermissionsBoundary: { Ref: "Table" } }),
      Missing: role({ PermissionsBoundary: { Ref: "NoSuchThing" } }),
      Text: role({ PermissionsBoundary: "not-an-arn" }),
      Attached: role({ PermissionsBoundary: { Ref: "Boundary2" } }),
      Boundary2: { Type: "AWS::IAM::ManagedPolicy", Properties: { Roles: [{ Ref: "None" }], PolicyDocument: {} } },
      Table: { Type: "AWS::DynamoDB::Table" },
      Good: role(),
    })).map((problem) => problem.replace(/:.*/u, "")).sort()).toEqual(["s/Attached", "s/Missing", "s/None", "s/NotAPolicy", "s/Text"]);
  });

  it("ignores a stack with no role, but fails a set of stacks with no role at all (the wrong directory)", () => {
    expect(boundaryProblems([...stack({ RoleBoundary: boundaryPolicy, A: role() }), { stackName: "empty", template: { Resources: { T: { Type: "AWS::DynamoDB::Table" } } } }])).toEqual([]);
    expect(boundaryProblems(stack({ T: { Type: "AWS::DynamoDB::Table" } }))).toEqual([expect.stringContaining("no AWS::IAM::Role")]);
  });

  it("feeds the Cloud documents through the same extraction and service-literal rule as Code's own", () => {
    const bad = { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "s3:*", Resource: "arn:aws:*rovara-staging-*" }] };
    const documents = extractPolicyDocuments("cloud:s", { Resources: { RoleBoundary: { ...boundaryPolicy, Properties: { PolicyDocument: bad } }, A: role() } }).documents;
    expect(documents.map((document) => document.label)).toEqual(expect.arrayContaining(["cloud:s/RoleBoundary/PolicyDocument", "cloud:s/A/AssumeRolePolicyDocument"]));
    expect(serviceFieldProblems(documents)).toHaveLength(1);
  });
});

describe("npm run iam:validate --cloud-templates (command line, no AWS)", () => {
  const tsx = join(import.meta.dirname, "../../node_modules/.bin/tsx");
  const script = join(import.meta.dirname, "../../scripts/validate-iam-policies.ts");
  const run = (...args: string[]): { status: number; output: string } => {
    try { return { status: 0, output: execFileSync(tsx, [script, "--local-only", "--cloud-only", ...args], { encoding: "utf8", stdio: "pipe" }) }; }
    catch (error) { const e = error as { status?: number; stdout?: string; stderr?: string }; return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
  };

  it("passes the good assembly, fails (exit 1) naming the role that escapes the boundary, and fails a wrong directory", () => {
    const ok = run("--cloud-templates", writeAssembly("cli-good", { "web.template.json": good }));
    expect(ok.status, ok.output).toBe(0);
    expect(ok.output).toContain("IAM policy validation passed");
    const escaped = run("--cloud-templates", writeAssembly("cli-bad", { "web.template.json": { Resources: { ...good.Resources, Rogue: role({ PermissionsBoundary: undefined }) } } }));
    expect(escaped.status).toBe(1);
    expect(escaped.output).toContain("FAIL boundary web/Rogue: has no PermissionsBoundary");
    expect(run("--cloud-templates", join(root, "empty")).status).not.toBe(0);
    expect(run().status).not.toBe(0);
  }, 120_000);
});
