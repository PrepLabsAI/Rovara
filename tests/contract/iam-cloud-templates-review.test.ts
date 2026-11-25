// L4 review (Opus): fail-closed edges of the Cloud input contract and the boundary rule that the builder's tests do not pin.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boundaryProblems, loadCloudStacks } from "../../scripts/iam-cloud-templates.js";

const root = mkdtempSync(join(tmpdir(), "iam-cloud-review-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
const boundaryPolicy = { Type: "AWS::IAM::ManagedPolicy", Properties: { PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "logs:*", Resource: "*" }] } } };
const role = (extra: Record<string, unknown> = {}) => ({ Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: trust, PermissionsBoundary: { Ref: "RoleBoundary" }, ...extra } });
const good = { Resources: { RoleBoundary: boundaryPolicy, A: role() } };

function dir(name: string, files: Record<string, string>): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(directory, file), text);
  return directory;
}
const manifest = (stacks: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ version: "1", artifacts: { ...extra, ...Object.fromEntries(Object.entries(stacks).map(([name, file]) => [name, { type: "aws:cloudformation:stack", properties: { templateFile: file, stackName: name } }])) } });

describe("input contract: every broken input throws", () => {
  it("a malformed manifest", () => {
    expect(() => loadCloudStacks(dir("bad-manifest", { "manifest.json": "{not json", "s.template.json": JSON.stringify(good) }))).toThrow();
  });
  it("a manifest naming a template that is not there", () => {
    expect(() => loadCloudStacks(dir("missing-template", { "manifest.json": manifest({ s: "s.template.json" }) }))).toThrow();
  });
  it("a listed or nested template that is not JSON", () => {
    expect(() => loadCloudStacks(dir("bad-template", { "manifest.json": manifest({ s: "s.template.json" }), "s.template.json": "{" }))).toThrow();
    expect(() => loadCloudStacks(dir("bad-nested", { "manifest.json": manifest({ s: "s.template.json" }), "s.template.json": JSON.stringify(good), "N.nested.template.json": "{" }))).toThrow();
  });
  it("a manifest that names only a nested cloud assembly (a CDK Stage) and no stack: no template, so it throws", () => {
    expect(() => loadCloudStacks(dir("stage-only", { "manifest.json": manifest({}, { "assembly-Prod": { type: "cdk:cloud-assembly", properties: { directoryName: "assembly-Prod" } } }) }))).toThrow(/no Cloud stack template/u);
  });
  it("a path that is a file, not a directory", () => {
    const directory = dir("a-file-parent", { "x.json": "{}" });
    expect(() => loadCloudStacks(join(directory, "x.json"))).toThrow();
  });
});

describe("boundary rule edges", () => {
  const one = (resources: Record<string, unknown>) => boundaryProblems([{ stackName: "s", template: { Resources: resources as never } }]);
  it("refuses Fn::If / parameter Ref / GetAtt boundaries (fails closed, not open)", () => {
    expect(one({ RoleBoundary: boundaryPolicy, A: role({ PermissionsBoundary: { "Fn::If": ["C", { Ref: "RoleBoundary" }, { Ref: "AWS::NoValue" }] } }) })).toHaveLength(1);
    expect(one({ RoleBoundary: boundaryPolicy, A: role({ PermissionsBoundary: { Ref: "BoundaryParam" } }) })).toHaveLength(1);
    expect(one({ RoleBoundary: boundaryPolicy, A: role({ PermissionsBoundary: { "Fn::GetAtt": ["RoleBoundary", "PolicyArn"] } }) })).toHaveLength(1);
  });
  it("refuses an AWS-managed policy ARN as a boundary (string, Fn::Sub or Fn::Join; any partition), but accepts a customer-managed one", () => {
    expect(one({ A: role({ PermissionsBoundary: "arn:aws:iam::aws:policy/AdministratorAccess" }) })).toHaveLength(1);
    expect(one({ A: role({ PermissionsBoundary: { "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/AdministratorAccess" } }) })).toHaveLength(1);
    expect(one({ A: role({ PermissionsBoundary: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/service-role/X"]] } }) })).toHaveLength(1);
    expect(one({ A: role({ PermissionsBoundary: "arn:aws-cn:iam::aws:policy/X" }) })).toHaveLength(1);
    expect(one({ A: role({ PermissionsBoundary: "arn:aws:iam::111122223333:policy/cloud/boundary" }) })).toEqual([]);
  });
  it("KNOWN GAP: AWS::IAM::User / Group are not checked (Cloud makes none today)", () => {
    expect(one({ RoleBoundary: boundaryPolicy, A: role(), U: { Type: "AWS::IAM::User", Properties: {} } })).toEqual([]);
  });
});

describe("command line", () => {
  const tsx = join(import.meta.dirname, "../../node_modules/.bin/tsx");
  const script = join(import.meta.dirname, "../../scripts/validate-iam-policies.ts");
  const run = (...args: string[]): number => {
    try { execFileSync(tsx, [script, ...args], { encoding: "utf8", stdio: "pipe" }); return 0; } catch (error) { return (error as { status?: number }).status ?? 1; }
  };
  it("a wrong directory next to a good one: every --cloud-templates directory must hold a role, so a second directory with templates but no role fails", () => {
    const goodDir = dir("cli-good", { "manifest.json": manifest({ s: "s.template.json" }), "s.template.json": JSON.stringify(good) });
    const noRoles = dir("cli-noroles", { "manifest.json": manifest({ t: "t.template.json" }), "t.template.json": JSON.stringify({ Resources: { R: { Type: "AWS::ECR::Repository" } } }) });
    expect(run("--local-only", "--cloud-only", "--cloud-templates", noRoles)).not.toBe(0);
    expect(run("--local-only", "--cloud-only", "--cloud-templates", goodDir, "--cloud-templates", noRoles)).not.toBe(0);
    expect(run("--local-only", "--cloud-only", "--cloud-templates", goodDir, "--cloud-templates", goodDir)).toBe(0);
  }, 120_000);
  it("refuses --file together with --cloud-templates or --cloud-only (it used to skip the Cloud directories silently)", () => {
    const file = join(dir("cli-file", { "d.json": JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] }) }), "d.json");
    expect(run("--local-only", "--cloud-only", "--cloud-templates", join(root, "nope"), "--file", file)).not.toBe(0);
    expect(run("--local-only", "--cloud-templates", dir("cli-file-good", { "manifest.json": manifest({ s: "s.template.json" }), "s.template.json": JSON.stringify(good) }), "--file", file)).not.toBe(0);
    expect(run("--local-only", "--file", file)).toBe(0);
  }, 120_000);
});
