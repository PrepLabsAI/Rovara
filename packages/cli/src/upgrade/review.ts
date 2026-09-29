// FR-042 and FR-043: every change an upgrade makes, with IAM changes called out separately, and a
// stop before replacing or deleting a table, user pool, bucket, KMS key or secret unless the operator
// types its name (or passes --allow-replace <logical-id>). Replacing one loses its data, so anything
// this code cannot read for certain (an unknown Replacement value or action, a cdk diff line it does
// not understand) is treated as needing that same review, never as safe.
import type { Ask, ConfirmFn } from "../deploy/commands.js";
import type { ChangeSetChange, DeployRequest, StackDeployer } from "../deploy/deployer.js";

export const DATA_RESOURCE_TYPES: ReadonlySet<string> = new Set(["AWS::DynamoDB::Table", "AWS::Cognito::UserPool", "AWS::S3::Bucket", "AWS::KMS::Key", "AWS::SecretsManager::Secret"]);

/** "unclear": a cdk diff resource line this code could not read; `line` holds it, and logicalId and
 * type are "" when they could not be read either. */
export interface DataChange { logicalId: string; type: string; verb: "replace" | "delete" | "unclear"; line?: string }
export interface ReviewedChanges { iam: ChangeSetChange[]; data: DataChange[]; other: ChangeSetChange[] }

/** Adding or importing a resource loses nothing, nor does a modification CloudFormation says replaces
 * nothing ("False"). Every other action and Replacement value, known or not, may lose data. */
const keepsData = (change: ChangeSetChange) => change.action === "Add" || change.action === "Import" || (change.action === "Modify" && change.replacement === "False");

export function reviewChanges(changes: ChangeSetChange[]): ReviewedChanges {
  const reviewed: ReviewedChanges = { iam: [], data: [], other: [] };
  for (const change of changes) {
    if (change.type.startsWith("AWS::IAM::")) reviewed.iam.push(change);
    else if (DATA_RESOURCE_TYPES.has(change.type) && !keepsData(change)) {
      reviewed.data.push({ logicalId: change.logicalId, type: change.type, verb: change.action === "Remove" ? "delete" : "replace" });
    } else reviewed.other.push(change);
  }
  return reviewed;
}

const changeLine = (change: ChangeSetChange) => `    ${change.action} ${change.logicalId} (${change.type})${change.replacement === "True" ? " [replacement]" : change.replacement === "Conditional" ? " [replacement: conditional]" : ""}`;

export function reviewLines(stackName: string, reviewed: ReviewedChanges): string[] {
  return [
    `Changes for ${stackName}:`,
    ...(reviewed.iam.length === 0 ? [] : ["  IAM changes:", ...reviewed.iam.map(changeLine)]),
    ...(reviewed.data.length === 0 ? [] : ["  Replaces or deletes data:", ...reviewed.data.map((entry) => `    ${entry.verb} ${entry.logicalId} (${entry.type})`)]),
    ...(reviewed.other.length === 0 ? [] : ["  Other changes:", ...reviewed.other.map(changeLine)]),
    ...(reviewed.iam.length + reviewed.data.length + reviewed.other.length === 0 ? ["  no resource changes"] : []),
  ];
}

/** FR-043: undefined when every data change is accepted; otherwise the refusal to report. */
export async function guardData(input: { stackName: string; data: DataChange[]; allowReplace: ReadonlySet<string>; yes: boolean; ask: Ask }): Promise<string | undefined> {
  for (const entry of input.data) {
    if (entry.logicalId !== "" && input.allowReplace.has(entry.logicalId)) continue;
    if (entry.verb === "unclear") {
      const line = entry.line ?? "";
      const allow = entry.logicalId === "" ? "" : `, or with --allow-replace ${entry.logicalId} if you accept it`;
      const refusal = `upgrade stopped: agentx could not read this line of cdk diff's output for ${input.stackName}, so it cannot tell whether it replaces or deletes data: ${line}. Nothing in ${input.stackName} changed. Run agentx upgrade again without --yes to review the change${allow}`;
      if (input.yes) return refusal;
      const token = entry.logicalId === "" ? "accept" : entry.logicalId;
      const typed = await input.ask(`agentx could not read this line of cdk diff's output for ${input.stackName}, so it may replace or delete data: ${line}. Check the diff above. Type ${token} to accept, or anything else to stop: `);
      if (typed.trim() !== token) return refusal;
      continue;
    }
    const refusal = `upgrade stopped: ${input.stackName} would ${entry.verb} ${entry.logicalId} (${entry.type}) and lose its data; nothing in ${input.stackName} changed. If you accept that, run agentx upgrade again with --allow-replace ${entry.logicalId}`;
    if (input.yes) return refusal;
    const typed = await input.ask(`${input.stackName} would ${entry.verb} ${entry.logicalId} (${entry.type}), losing its data. Type ${entry.logicalId} to accept, or anything else to stop: `);
    if (typed.trim() !== entry.logicalId) return refusal;
  }
  return undefined;
}

/** The templates engine's confirmation. A refusal returns false, so the engine deletes its change set,
 * and keeps the reason for agentx upgrade to report instead of the engine's generic words. */
export function upgradeConfirm(input: { write: (line: string) => void; ask: Ask; yes: boolean; allowReplace: ReadonlySet<string> }): { confirm: ConfirmFn; refusal(): string | undefined } {
  let refusal: string | undefined;
  return {
    refusal: () => refusal,
    async confirm({ stackName, changes }) {
      const reviewed = reviewChanges(changes);
      for (const line of reviewLines(stackName, reviewed)) input.write(line);
      refusal = await guardData({ stackName, data: reviewed.data, allowReplace: input.allowReplace, yes: input.yes, ask: input.ask });
      if (refusal !== undefined) return false;
      if (input.yes) return true;
      if (/^y(es)?$/i.test((await input.ask(`Apply these changes to ${stackName}? [y/N] `)).trim())) return true;
      refusal = `upgrade stopped before ${stackName}: nothing in it changed. Stacks upgraded before it keep the new release; run agentx upgrade again to continue`;
      return false;
    },
  };
}

// cdk diff's resource lines: "[~] AWS::DynamoDB::Table State StateABC123 replace", then indented
// property lines such as " └─ [~] KeySchema (requires replacement)". The third word is the construct
// path's last part, the fourth the logical id. The pinned CDK's exact output could not be checked
// offline (the live check, Task 20, records one), so the parse is defensive: inside the Resources
// section, a line that opens with a change mark but does not read as a resource line is "unclear",
// which guardData stops on like a replacement.
const RESOURCE_LINE = /^\[([-~+])\]\s+(AWS::[A-Za-z0-9]+::[A-Za-z0-9:]+)\s+\S+\s+(\S+)(.*)$/;
const MARKED_LINE = /^\[[^\]]{1,2}\]/;
const LOOSE_RESOURCE = /^\[[^\]]{1,2}\]\s+(AWS::[A-Za-z0-9]+::[A-Za-z0-9:]+)\s+\S+\s+(\S+)/;
// Every section heading cdk diff prints besides Resources; any other unindented heading also ends it.
const HEADING = /^[A-Z][A-Za-z ]*$|^Stack \S+$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function cdkDiffRisks(text: string): { data: DataChange[]; iam: boolean } {
  const data: DataChange[] = [];
  let iam = /IAM Statement Changes|IAM Policy Changes/.test(text);
  let inResources = false;
  // The stateful resource the property lines below belong to, until its replacement is recorded.
  let current: DataChange | undefined;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(ANSI, "").trim();
    if (line === "") continue;
    if (!raw.startsWith(" ") && HEADING.test(line)) {
      inResources = line === "Resources";
      current = undefined;
      continue;
    }
    if (!inResources) continue;
    if (!MARKED_LINE.test(line)) {
      // A property line ("└─ [~] BucketName (requires replacement)") of the resource above.
      if (current !== undefined && /replace/i.test(line)) {
        data.push(current);
        current = undefined;
      }
      continue;
    }
    current = undefined;
    const match = RESOURCE_LINE.exec(line);
    if (match === null) {
      const loose = LOOSE_RESOURCE.exec(line);
      if (loose?.[1]?.startsWith("AWS::IAM::") === true) iam = true;
      data.push({ logicalId: loose?.[2] ?? "", type: loose?.[1] ?? "", verb: "unclear", line });
      continue;
    }
    const [, mark, type = "", logicalId = "", rest = ""] = match;
    if (type.startsWith("AWS::IAM::")) iam = true;
    if (!DATA_RESOURCE_TYPES.has(type)) continue;
    if (mark === "-") data.push({ logicalId, type, verb: "delete" });
    else if (mark === "~") {
      if (/replace/i.test(rest)) data.push({ logicalId, type, verb: "replace" });
      else current = { logicalId, type, verb: "replace" };
    }
  }
  return { data, iam };
}

/** The cdk engine has no change set to confirm: each stack is reviewed (cdk diff) just before it deploys. */
export function cdkReviewedDeployer(inner: StackDeployer, review: (request: DeployRequest) => Promise<void>): StackDeployer {
  return {
    async deploy(request) {
      await review(request);
      return inner.deploy(request);
    },
    outputs: (stackName) => inner.outputs(stackName),
  };
}
