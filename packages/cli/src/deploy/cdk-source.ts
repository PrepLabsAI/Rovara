// Issue 152: what the cdk engine reads from its --source checkout itself, so a source-built agentx
// needs no release directory. sourceReleaseVersion takes the version from the checkout's release
// tag; synthDeclaredParameters runs one `cdk synth` of the checkout, with exactly the app and
// context the deploy uses, and reads which parameters each stack's template declares. The deploy
// still runs `cdk deploy` as before; the synthesized assembly is only read, never deployed.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { agentXError, environmentStackName } from "@agentx/contracts";
import { CDK_CONSTRUCT_IDS, cdkAppArguments, type CommandRunner } from "./cdk-engine.js";
import type { DeployPart } from "./parameters.js";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A release tag: v, then the version release.json's schema accepts. */
const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

const CHECK_OUT = "check out a release tag (vX.Y.Z) cleanly";

/**
 * The release version of a clean checkout: the one release tag (vX.Y.Z) at HEAD, and HEAD's commit.
 * Refuses a source that is not a git checkout, one with uncommitted changes (before reading its
 * tags), one at no release tag, and one at several final release tags: the version must never be a
 * guess. A final tag wins over prerelease tags on the same commit.
 */
export async function sourceReleaseVersion(input: { runner: CommandRunner; source: string }): Promise<{ version: string; gitCommit: string }> {
  const { runner, source } = input;
  let status: string;
  try {
    ({ stdout: status } = await runner.run("git", ["status", "--porcelain"], { cwd: source, display: "git status --porcelain" }));
  } catch (error) {
    const firstLine = errorMessage(error).split("\n")[0];
    throw Object.assign(agentXError("CONFIG_INVALID", `${source} is not a git checkout (${firstLine}); ${CHECK_OUT}`), { cause: error });
  }
  if (status.trim() !== "") throw agentXError("CONFIG_INVALID", `source at ${source} has uncommitted changes; ${CHECK_OUT}`);

  let tags: string[];
  try {
    const { stdout } = await runner.run("git", ["tag", "--points-at", "HEAD"], { cwd: source, display: "git tag --points-at HEAD" });
    tags = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  } catch (error) {
    const firstLine = errorMessage(error).split("\n")[0];
    throw Object.assign(agentXError("CONFIG_INVALID", `the cdk engine takes the release version from the tag of --source, but ${source} is at no tag (${firstLine}); ${CHECK_OUT}`), { cause: error });
  }
  const releaseTags = tags.filter((tag) => RELEASE_TAG.test(tag));
  // An rc promoted to the final release on the same commit carries both tags: the final one is the
  // version. Only when there is no final tag does a prerelease tag count (init and upgrade refuse it).
  const finalTags = releaseTags.filter((tag) => !tag.includes("-"));
  const candidates = finalTags.length > 0 ? finalTags : releaseTags;
  const prefix = `the cdk engine takes the release version from the tag of --source, but ${source} is at`;
  if (candidates.length > 1) throw agentXError("CONFIG_INVALID", `${prefix} several release tags (${candidates.join(", ")}); check out a commit with one release tag, or pass --release <dir> for the one you mean`);
  const [tag] = candidates;
  if (tag === undefined) {
    throw agentXError("CONFIG_INVALID", `${prefix} ${tags.length === 0 ? "no release tag" : `${tags.join(", ")}, not a release tag`}; ${CHECK_OUT}`);
  }

  const { stdout: head } = await runner.run("git", ["rev-parse", "HEAD"], { cwd: source, display: "git rev-parse HEAD" });
  const gitCommit = head.trim();
  if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw agentXError("CONFIG_INVALID", `git rev-parse HEAD in ${source} did not name a commit`);
  return { version: RELEASE_TAG.exec(tag)?.[1] as string, gitCommit };
}

interface AssemblyArtifact {
  type?: unknown;
  properties?: { templateFile?: unknown; stackName?: unknown };
}

/** What a part's stack is in the assembly: its declared parameters, or why it cannot be read. */
type StackEntry = { declared: ReadonlySet<string> } | { problem: string };

/**
 * Runs `cdk synth` once in `source` (built already: prepareDeployment runs buildSource first) into a
 * temporary directory, with the deploy's own app and context (cdkAppArguments), and returns each
 * part's declared parameter names. The stacks are found through the cloud assembly's manifest.json,
 * never by guessing file names: `artifacts[<construct id>]` of type `aws:cloudformation:stack`, whose
 * `properties.templateFile` names the template and `properties.stackName` the physical stack name
 * (checked against a real `cdk synth` of this repo, cloud assembly schema 54). The directory is
 * removed before this returns. A part the assembly has no stack for, or names differently from the
 * stack the deploy targets, is refused when it is asked for, so a part this run does not deploy
 * (identity with your own OIDC provider) never fails it.
 */
export async function synthDeclaredParameters(input: { runner: CommandRunner; source: string; env: string; region: string; identityMode: "cognito" | "oidc" }): Promise<(part: DeployPart) => ReadonlySet<string>> {
  const { source } = input;
  const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-synth-"));
  const entries = new Map<DeployPart, StackEntry>();
  try {
    const args = ["--no-install", "cdk", "synth", "--quiet", "-o", dir, ...cdkAppArguments(input)];
    const display = ["npx", ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
    // quiet: the synth's stdout is a template listing only this code reads; its warnings (stderr) still show.
    await input.runner.run("npx", args, { cwd: source, display, quiet: true });

    let artifacts: Record<string, AssemblyArtifact>;
    try {
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as { artifacts?: unknown };
      if (manifest.artifacts === null || typeof manifest.artifacts !== "object") throw new Error("it lists no artifacts");
      artifacts = manifest.artifacts as Record<string, AssemblyArtifact>;
    } catch (error) {
      throw agentXError("CONFIG_INVALID", `cdk synth of ${source} wrote no readable manifest.json (${errorMessage(error)}); check the checkout builds`);
    }

    for (const [part, id] of Object.entries(CDK_CONSTRUCT_IDS) as Array<[DeployPart, string]>) {
      const expected = environmentStackName(input.env, part);
      const artifact = Object.hasOwn(artifacts, id) ? artifacts[id] : undefined;
      if (artifact?.type !== "aws:cloudformation:stack" || typeof artifact.properties?.templateFile !== "string") {
        entries.set(part, { problem: `cdk synth of ${source} made no stack ${id} (${expected}); check the checkout builds` });
        continue;
      }
      const stackName = typeof artifact.properties.stackName === "string" ? artifact.properties.stackName : id;
      if (stackName !== expected) {
        entries.set(part, { problem: `cdk synth of ${source} made stack ${id} as ${stackName}, not ${expected}` });
        continue;
      }
      const file = resolve(dir, artifact.properties.templateFile);
      if (!file.startsWith(resolve(dir) + sep)) throw agentXError("CONFIG_INVALID", `cdk synth of ${source} names a template outside its output directory for ${id}`);
      let template: { Parameters?: unknown };
      try {
        template = JSON.parse(await readFile(file, "utf8")) as { Parameters?: unknown };
      } catch (error) {
        throw agentXError("CONFIG_INVALID", `cdk synth of ${source} wrote an unreadable template for ${id} (${errorMessage(error)})`);
      }
      const parameters = template.Parameters !== null && typeof template.Parameters === "object" ? Object.keys(template.Parameters) : [];
      entries.set(part, { declared: new Set(parameters) });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return (part) => {
    const entry = entries.get(part);
    if (entry === undefined) throw agentXError("CONFIG_INVALID", `cdk synth of ${source} has no stack for ${part}`);
    if ("problem" in entry) throw agentXError("CONFIG_INVALID", entry.problem);
    return entry.declared;
  };
}
