// The Cloud half of `npm run iam:validate`: reads SYNTHESIZED Cloud templates (this public repository holds no Cloud code, so the templates arrive as files) and checks that every IAM role in
// them carries a permissions boundary. The policy documents of the templates then go through the same checks as Code's own (scripts/validate-iam-policies.ts).
//
// INPUT CONTRACT. One or more CDK cloud-assembly directories (a `cdk.out`), each produced by a Cloud build step (`cdk synth ... -o <dir>`; one
// directory per Cloud app). A directory holds `manifest.json` (its `aws:cloudformation:stack` artifacts name each stack and its
// `templateFile`) and the templates. Nested-stack templates (`*.nested.template.json`) in the directory are read too, since CDK does not list them as stacks. A directory without a manifest is read
// as a flat set of `*.template.json` files (the stack name is the file name without the suffix). A directory that yields no template, or templates with no IAM role at all, FAILS: the gate must
// never pass because it was pointed at the wrong place.
//
// THE BOUNDARY RULE (structural; no AWS). Every AWS::IAM::Role has a PermissionsBoundary that is either a `Ref` to an AWS::IAM::ManagedPolicy of the same template that is attached to nothing (a
// boundary policy has no Roles, Users or Groups), or an ARN of a managed policy (a string, `Fn::Sub` or `Fn::Join` that holds `:policy/`, or an `Fn::ImportValue`). Anything else, or no
// PermissionsBoundary, is a problem (an AWS-managed policy `arn:<partition>:iam::aws:policy/...` is refused: it is no boundary). The check runs once per directory, and each directory must hold at least
// one role. Whether the boundary ALLOWS what the roles do is Cloud's own check (the Cloud repository's role-boundary check); this is the cheap guard that no role escapes it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface CloudResource { Type: string; Properties?: Record<string, unknown> }
export interface CloudTemplate { Resources?: Record<string, CloudResource> }
export interface CloudStack { stackName: string; template: CloudTemplate }

const NESTED_SUFFIX = ".nested.template.json";
const FLAT_SUFFIX = ".template.json";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** The stacks the manifest names, as [stack name, template file]. */
function manifestStacks(directory: string): Array<[string, string]> {
  const manifest = readJson(join(directory, "manifest.json"));
  const artifacts = isObject(manifest) && isObject(manifest.artifacts) ? manifest.artifacts : {};
  return Object.entries(artifacts).flatMap(([id, artifact]): Array<[string, string]> => {
    if (!isObject(artifact) || artifact.type !== "aws:cloudformation:stack" || !isObject(artifact.properties)) return [];
    const { templateFile, stackName } = artifact.properties;
    return typeof templateFile === "string" ? [[typeof stackName === "string" ? stackName : id, templateFile]] : [];
  });
}

/** Every stack template of one Cloud cdk.out directory (see the input contract above). */
export function loadCloudStacks(directory: string): CloudStack[] {
  if (!existsSync(directory)) throw new Error(`Cloud templates directory ${directory} does not exist`);
  const files = readdirSync(directory);
  const listed = files.includes("manifest.json") ? manifestStacks(directory) : [];
  const known = new Set(listed.map(([, file]) => file));
  const extra = files
    .filter((file) => !known.has(file) && (listed.length === 0 ? file.endsWith(FLAT_SUFFIX) : file.endsWith(NESTED_SUFFIX)))
    .map((file): [string, string] => [basename(file, file.endsWith(NESTED_SUFFIX) ? ".template.json" : FLAT_SUFFIX), file]);
  const stacks = [...listed, ...extra].map(([stackName, file]) => ({ stackName, template: readJson(join(directory, file)) as CloudTemplate }));
  if (stacks.length === 0) throw new Error(`no Cloud stack template found in ${directory} (expected a cdk.out directory, or *.template.json files)`);
  return stacks;
}

/** Text of a value that is an ARN in pieces, for the `:policy/` test: strings, and the string parts of Fn::Sub and Fn::Join. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (!isObject(value)) return "";
  const parts = Object.entries(value).filter(([key]) => key === "Fn::Sub" || key === "Fn::Join");
  return parts.map(([, argument]) => textOf(argument)).join("");
}

const attachedTo = (properties: Record<string, unknown> | undefined): boolean => ["Roles", "Users", "Groups"].some((key) => properties?.[key] !== undefined);

/** Why a role's PermissionsBoundary is not acceptable, or undefined when it is. */
function boundaryProblem(boundary: unknown, resources: Record<string, CloudResource>): string | undefined {
  if (boundary === undefined) return "has no PermissionsBoundary";
  if (isObject(boundary) && Object.keys(boundary).length === 1 && "Ref" in boundary) {
    const target = typeof boundary.Ref === "string" ? resources[boundary.Ref] : undefined;
    if (target?.Type !== "AWS::IAM::ManagedPolicy") return `its PermissionsBoundary refers to ${JSON.stringify(boundary.Ref)}, which is not an AWS::IAM::ManagedPolicy of this template`;
    return attachedTo(target.Properties) ? `its PermissionsBoundary ${JSON.stringify(boundary.Ref)} is attached to roles, users or groups (a boundary policy is attached to nothing)` : undefined;
  }
  if (isObject(boundary) && "Fn::ImportValue" in boundary) return undefined;
  const text = textOf(boundary);
  if (/:iam::aws:policy\//u.test(text)) return "its PermissionsBoundary is an AWS-managed policy (that limits nothing a customer-managed boundary would)";
  return text.includes(":policy/") ? undefined : "its PermissionsBoundary is not a managed policy ARN or a Ref to a managed policy";
}

/** `<stack>/<role>: problem` for every IAM role of the stacks without an acceptable permissions boundary; a set of stacks with no role at all is itself a problem. */
export function boundaryProblems(stacks: readonly CloudStack[]): string[] {
  let roles = 0;
  const problems = stacks.flatMap(({ stackName, template }) => {
    const resources = template.Resources ?? {};
    return Object.entries(resources).flatMap(([id, resource]) => {
      if (resource.Type !== "AWS::IAM::Role") return [];
      roles += 1;
      const problem = boundaryProblem(resource.Properties?.PermissionsBoundary, resources);
      return problem === undefined ? [] : [`${stackName}/${id}: ${problem}`];
    });
  });
  return roles === 0 ? [...problems, "no AWS::IAM::Role in the Cloud templates (the wrong directory, or a synth that made nothing)"] : problems;
}
