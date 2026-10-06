// The installer (the Launch in AWS button): its quick-create template and the setup page's code
// package, laid out as they are uploaded to the installer bucket (docs/releases.md):
//
//   <out>/<version>/installer.template.json
//   <out>/<version>/packages/<assetId>.zip
//   <out>/latest/installer.template.json        (the README's button opens this one)
//
// Quick-create runs in the visitor's own account, with no CDK bootstrap and nothing to fill in,
// so the template is synthesized with the legacy synthesizer and every code package's bucket, key
// and hash parameter gets its upload's location as its default. The job runs exactly this
// release's CLI (CliPackage's default), whose templates match.
//
//   tsx scripts/release/installer.ts --version <x.y.z> --bucket <installer bucket> --out <dir>
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { App, LegacyStackSynthesizer, type IReusableStackSynthesizer } from "aws-cdk-lib";
import { CLI_PACKAGE_NAME } from "@agentx/contracts";
import { INSTALLER_DESCRIPTION, InstallerStack } from "../../infra/lib/installer.js";
import { checkedNoAmbientCdkContext, checkedVersion, RELEASE_SYNTH_ROOT, withRepoRootCwd } from "./build.js";
import { zipDirectory } from "./zip.js";

/** The one region the installer is published for: Lambda reads its code from a bucket in its own region. */
export const INSTALLER_REGION = "us-east-1";
export const INSTALLER_STACK = "AgentXInstaller";
export const INSTALLER_TEMPLATE = "installer.template.json";

/** The quick-create address for a published installer (the README's Launch in AWS button). */
export function launchUrl(bucket: string, path = `latest/${INSTALLER_TEMPLATE}`): string {
  const templateUrl = `https://${bucket}.s3.${INSTALLER_REGION}.amazonaws.com/${path}`;
  return `https://console.aws.amazon.com/cloudformation/home?region=${INSTALLER_REGION}#/stacks/quickcreate?templateURL=${encodeURIComponent(templateUrl)}&stackName=agentx-installer`;
}

interface TemplateJson { Parameters?: Record<string, { Default?: string }>; [section: string]: unknown }

/** Every `{ Ref: <name> }` to one of `values`' parameters becomes the value itself, and those
 * parameters leave the template. Throws if any reference is left behind. */
export function inlineParameters(template: TemplateJson, values: ReadonlyMap<string, string>): TemplateJson {
  const replace = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(replace);
    if (node === null || typeof node !== "object") return node;
    const entries = Object.entries(node as Record<string, unknown>);
    if (entries.length === 1 && entries[0]?.[0] === "Ref" && typeof entries[0][1] === "string" && values.has(entries[0][1])) return values.get(entries[0][1]);
    return Object.fromEntries(entries.map(([key, value]) => [key, replace(value)]));
  };
  const parameters = Object.fromEntries(Object.entries(template.Parameters ?? {}).filter(([name]) => !values.has(name)));
  const inlined = { ...(replace(template) as TemplateJson), Parameters: parameters };
  const text = JSON.stringify(inlined);
  for (const name of values.keys()) if (text.includes(`"${name}"`)) throw new Error(`parameter ${name} is still referenced after inlining`);
  return inlined;
}

export async function buildInstaller(input: { version: string; bucket: string; out: string }): Promise<{ template: string; packages: string[] }> {
  const version = checkedVersion(input.version);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error(`not an S3 bucket name: ${JSON.stringify(input.bucket)}`);
  checkedNoAmbientCdkContext();
  await mkdir(RELEASE_SYNTH_ROOT, { recursive: true });
  const synthDir = await mkdtemp(join(RELEASE_SYNTH_ROOT, "installer-"));
  try {
    // Its own app, not buildAgentXApp's: the installer belongs to no environment, so none of an
    // environment's naming, role path, permissions boundary or tags applies to it.
    const assembly = withRepoRootCwd(() => {
      const app = new App({ outdir: synthDir, defaultStackSynthesizer: new LegacyStackSynthesizer() as IReusableStackSynthesizer });
      new InstallerStack(app, INSTALLER_STACK, { env: { region: INSTALLER_REGION }, description: INSTALLER_DESCRIPTION });
      return app.synth();
    });
    const stack = assembly.stacks.find((each) => each.stackName === INSTALLER_STACK);
    if (stack === undefined) throw new Error(`the synth produced no ${INSTALLER_STACK} stack`);
    let template = structuredClone(stack.template) as TemplateJson;
    const parameters = template.Parameters ?? {};
    // Where each code package is uploaded, written into the template itself: quick-create would
    // otherwise show every code location as a field to fill in.
    const fixed = new Map<string, string>();
    const setDefault = (name: string, value: string) => {
      if (parameters[name] === undefined) throw new Error(`the ${INSTALLER_STACK} template has no ${name} parameter`);
      fixed.set(name, value);
    };
    await mkdir(join(input.out, version, "packages"), { recursive: true });
    const packages: string[] = [];
    for (const asset of stack.assets) {
      if (asset.packaging !== "zip") throw new Error(`the installer has a ${asset.packaging} asset (${asset.id}); only zip-packaged Lambda code can be published`);
      const legacy = asset as typeof asset & { s3BucketParameter: string; s3KeyParameter: string; artifactHashParameter: string };
      const file = join(version, "packages", `${asset.id}.zip`);
      await writeFile(join(input.out, file), await zipDirectory(join(assembly.directory, asset.path)));
      packages.push(file);
      setDefault(legacy.s3BucketParameter, input.bucket);
      // The legacy synthesizer splits the key at "||" into its prefix and file name.
      setDefault(legacy.s3KeyParameter, `${version}/packages/||${asset.id}.zip`);
      setDefault(legacy.artifactHashParameter, asset.sourceHash);
    }
    template = inlineParameters(template, fixed);
    const cli = template.Parameters?.CliPackage;
    if (cli === undefined) throw new Error(`the ${INSTALLER_STACK} template has no CliPackage parameter`);
    cli.Default = `${CLI_PACKAGE_NAME}@${version}`;
    const text = `${JSON.stringify(template, null, 2)}\n`;
    await writeFile(join(input.out, version, INSTALLER_TEMPLATE), text, "utf8");
    await mkdir(join(input.out, "latest"), { recursive: true });
    await writeFile(join(input.out, "latest", INSTALLER_TEMPLATE), text, "utf8");
    return { template: join(version, INSTALLER_TEMPLATE), packages };
  } finally {
    await rm(synthDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { version: { type: "string" }, bucket: { type: "string" }, out: { type: "string" } } });
    if (values.version === undefined || values.bucket === undefined || values.out === undefined) {
      throw new Error("usage: tsx scripts/release/installer.ts --version <x.y.z> --bucket <installer bucket> --out <dir>");
    }
    const built = await buildInstaller({ version: values.version, bucket: values.bucket, out: resolve(values.out) });
    process.stdout.write(`wrote the installer ${built.template} and ${built.packages.length} code package(s); it launches at ${launchUrl(values.bucket)}\n`);
  } catch (error) {
    process.stderr.write(`agentx installer build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
