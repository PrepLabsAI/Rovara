// The Launch in AWS button's installer, as a release publishes it (scripts/release/installer.ts):
// a quick-create template that needs nothing in the visitor's account but its three answers, its
// code package, and the button that opens it.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildInstaller, inlineParameters, INSTALLER_TEMPLATE, launchUrl } from "../../scripts/release/installer.js";

const BUCKET = "rovara-installer-us-east-1";

describe("inlining the code package's location", () => {
  it("writes each value where its parameter was referenced, and drops the parameter", () => {
    const template = {
      Parameters: { Bucket: {}, Keep: { Default: "x" } },
      Resources: { Fn: { Properties: { Code: { S3Bucket: { Ref: "Bucket" }, S3Key: { "Fn::Join": ["", [{ Ref: "Bucket" }, "/a"]] } }, Other: { Ref: "Keep" } } } },
    };
    expect(inlineParameters(template, new Map([["Bucket", "b"]]))).toEqual({
      Parameters: { Keep: { Default: "x" } },
      Resources: { Fn: { Properties: { Code: { S3Bucket: "b", S3Key: { "Fn::Join": ["", ["b", "/a"]] } }, Other: { Ref: "Keep" } } } },
    });
  });

  it("refuses to leave a reference it could not replace", () => {
    const template = { Parameters: { Bucket: {} }, Resources: { Fn: { Properties: { Name: { "Fn::GetAtt": ["Bucket", "Arn"] } } } } };
    expect(() => inlineParameters(template, new Map([["Bucket", "b"]]))).toThrow("parameter Bucket is still referenced after inlining");
  });
});

describe("the published installer", () => {
  let out: string;
  let template: { Parameters: Record<string, { Default?: string }>; Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>; Metadata?: Record<string, unknown> };
  let built: Awaited<ReturnType<typeof buildInstaller>>;

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "agentx-installer-"));
    built = await buildInstaller({ version: "1.2.3", bucket: BUCKET, out });
    template = JSON.parse(await readFile(join(out, built.template), "utf8")) as typeof template;
  }, 240_000);
  afterAll(async () => { await rm(out, { recursive: true, force: true }); });

  it("is laid out as the bucket holds it, with latest/ the same template as its version's", async () => {
    expect(built.template).toBe(`1.2.3/${INSTALLER_TEMPLATE}`);
    expect(built.packages).toHaveLength(1);
    expect((await stat(join(out, built.packages[0]!))).size).toBeGreaterThan(10_000);
    expect(await readFile(join(out, "latest", INSTALLER_TEMPLATE), "utf8")).toBe(await readFile(join(out, built.template), "utf8"));
  });

  it("asks only the three answers (and the CLI's package, pinned to this release), in plain words", () => {
    expect(Object.keys(template.Parameters).sort()).toEqual(["AdminEmail", "CliPackage", "GitHubOwner", "InstallName"]);
    expect(template.Parameters.CliPackage?.Default).toBe("@preplabsai/rovara-code@1.2.3");
    expect(JSON.stringify(template.Metadata)).toContain("Your email");
  });

  it("reads the setup page's code from the installer bucket, and needs no CDK bootstrap, no environment and no role path", () => {
    const text = JSON.stringify(template);
    const page = Object.values(template.Resources).find((resource) => resource.Type === "AWS::Lambda::Function" && JSON.stringify(resource.Properties.Code).includes("S3Bucket"));
    expect(page?.Properties.Code).toMatchObject({ S3Bucket: BUCKET });
    expect(JSON.stringify(page?.Properties.Code)).toContain(`1.2.3/packages/||${built.packages[0]!.split("/").at(-1)}`);
    for (const absent of ["cdk-hnb659fds", "BootstrapVersion", "qqenv-placeholderqq", "PermissionsBoundaryArn", "AssetParameters"]) expect(text).not.toContain(absent);
    for (const resource of Object.values(template.Resources).filter((each) => each.Type === "AWS::IAM::Role")) expect(resource.Properties.Path).toBeUndefined();
  });

  it("is what the README's and the install guide's button opens", async () => {
    for (const doc of ["README.md", "docs/install.md"]) expect(await readFile(doc, "utf8"), doc).toContain(`<a href="${launchUrl(BUCKET).replaceAll("&", "&amp;")}"><img src="`);
    expect(await readFile("docs/assets/launch-in-aws.svg", "utf8")).toContain("Launch in AWS");
    expect(decodeURIComponent(launchUrl(BUCKET))).toContain(`https://${BUCKET}.s3.us-east-1.amazonaws.com/latest/${INSTALLER_TEMPLATE}`);
  });
});
