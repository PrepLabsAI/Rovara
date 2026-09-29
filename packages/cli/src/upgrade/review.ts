// FR-042 and FR-043: every change an upgrade makes, with IAM changes called out separately, and a
// stop before replacing or deleting a table, user pool, bucket, KMS key, secret, queue or log group
// unless the operator types its name (or passes --allow-replace <logical-id>). Replacing one loses
// its data, so anything this code cannot read for certain (an unknown Replacement value or action, a
// cdk diff line it does not understand) is treated as needing that same review, never as safe.
import type { Ask, ConfirmFn } from "../deploy/commands.js";
import type { ChangeSetChange, DeployRequest, StackDeployer } from "../deploy/deployer.js";

const LOG_GROUP = "AWS::Logs::LogGroup";
export const DATA_RESOURCE_TYPES: ReadonlySet<string> = new Set(["AWS::DynamoDB::Table", "AWS::Cognito::UserPool", "AWS::S3::Bucket", "AWS::KMS::Key", "AWS::SecretsManager::Secret", "AWS::SQS::Queue", LOG_GROUP]);

/** Resource policies grant access like IAM policies do, so their changes are shown with the IAM
 * changes (as is a KMS key's KeyPolicy). */
const POLICY_RESOURCE_TYPES: ReadonlySet<string> = new Set(["AWS::S3::BucketPolicy", "AWS::Lambda::Permission", "AWS::SQS::QueuePolicy", "AWS::SNS::TopicPolicy", "AWS::SecretsManager::ResourcePolicy"]);
const isIamType = (type: string) => type.startsWith("AWS::IAM::") || POLICY_RESOURCE_TYPES.has(type);

/** "orphan": cdk diff says a retained resource leaves the stack (its data stays, unmanaged).
 * "unclear": cdk diff output this code could not read; `line` holds it, and logicalId and type are ""
 * when they could not be read either. */
export interface DataChange { logicalId: string; type: string; verb: "replace" | "delete" | "orphan" | "unclear"; line?: string }
export interface ReviewedChanges { iam: ChangeSetChange[]; data: DataChange[]; other: ChangeSetChange[] }

/** Adding or importing a resource loses nothing, nor does a modification CloudFormation says replaces
 * nothing ("False"). Every other action and Replacement value, known or not, may lose data. */
const keepsData = (change: ChangeSetChange) => change.action === "Add" || change.action === "Import" || (change.action === "Modify" && change.replacement === "False");

export function reviewChanges(changes: ChangeSetChange[]): ReviewedChanges {
  const reviewed: ReviewedChanges = { iam: [], data: [], other: [] };
  for (const change of changes) {
    if (DATA_RESOURCE_TYPES.has(change.type) && !keepsData(change)) {
      reviewed.data.push({ logicalId: change.logicalId, type: change.type, verb: change.action === "Remove" ? "delete" : "replace" });
    } else if (isIamType(change.type) || (change.type === "AWS::KMS::Key" && change.action === "Modify")) {
      // A change set does not say which property changed, so a KMS key's modification may be its KeyPolicy.
      reviewed.iam.push(change);
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

/** What a data change does, for the refusal and the prompt: "replace State (AWS::DynamoDB::Table) and lose its data". */
function consequence(entry: DataChange): string {
  const what = `${entry.logicalId} (${entry.type})`;
  if (entry.verb === "orphan") return `remove ${what} from the stack, which orphans the retained ${entry.type === LOG_GROUP ? "log group" : "resource"}`;
  if (entry.type === LOG_GROUP) return `${entry.verb} ${what}, which deletes its logs`;
  return `${entry.verb} ${what} and lose its data`;
}

const listed = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1) ?? ""}`);

function refusalFor(stackName: string, refused: DataChange[]): string {
  const known = refused.filter((entry) => entry.verb !== "unclear");
  const unclear = refused.filter((entry) => entry.verb === "unclear");
  const clauses = [
    ...(known.length === 0 ? [] : [`${stackName} would ${listed(known.map(consequence))}`]),
    ...(unclear.length === 0 ? [] : [`agentx could not read cdk diff's output for ${stackName}, so it cannot tell whether it replaces or deletes data (${unclear.map((entry) => entry.line ?? "").join("; ")})`]),
  ];
  const ids = refused.map((entry) => entry.logicalId).filter((id) => id !== "");
  const steps = [
    ...(unclear.length === 0 ? [] : ["Check the diff above, and run agentx upgrade again without --yes to review it"]),
    ...(ids.length === 0 ? [] : [`If you accept that, run agentx upgrade again with ${ids.map((id) => `--allow-replace ${id}`).join(" ")}`]),
  ];
  return `upgrade stopped: ${clauses.join("; ")}; nothing in ${stackName} changed. ${steps.join(". ")}`;
}

/** FR-043: undefined when every data change is accepted; otherwise one refusal naming every change
 * not accepted. Interactively, each is asked in turn until one is declined. */
export async function guardData(input: { stackName: string; data: DataChange[]; allowReplace: ReadonlySet<string>; yes: boolean; ask: Ask }): Promise<string | undefined> {
  const pending = input.data.filter((entry) => entry.logicalId === "" || !input.allowReplace.has(entry.logicalId));
  if (pending.length === 0) return undefined;
  if (input.yes) return refusalFor(input.stackName, pending);
  for (const [index, entry] of pending.entries()) {
    const token = entry.logicalId === "" ? "accept" : entry.logicalId;
    const prompt = entry.verb === "unclear"
      ? `agentx could not read cdk diff's output for ${input.stackName}, so it may replace or delete data (${entry.line ?? ""}). Check the diff above. Type ${token} to accept, or anything else to stop: `
      : `${input.stackName} would ${consequence(entry)}. Type ${token} to accept, or anything else to stop: `;
    if ((await input.ask(prompt)).trim() !== token) return refusalFor(input.stackName, pending.slice(index));
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

// cdk diff's output, as @aws-cdk/cloudformation-diff's Formatter prints it (aws-cdk 2.1142.0):
// section headings at column 0; in Resources, one line per resource at column 0,
// "[~] AWS::DynamoDB::Table State StateABC123 replace" (mark, type, construct path when known,
// logical id, impact: replace, may be replaced, destroy, orphan or import); then its property lines,
// every one indented: " └─ [~] KeySchema (requires replacement)", and for an array or type change a
// JSON hunk of "[ ]", "[-]" and "[+]" lines. The live check (Task 20) records one real diff. The
// parse is defensive: a column-0 marked line in Resources that is not a resource line, a line naming
// a guarded type that is not a resource line (in any section), and output that shows neither a
// Resources section nor "There were no differences", are all "unclear", which guardData stops on.
//
// A limit to review in the live check: `--method=template` compares templates, so it cannot see a
// replacement caused only by a changed parameter value, or one that cascades through a Ref or GetAtt
// to a resource whose template did not change. The templates engine's change set does see those.
const MARK = /^\[([^\]]{1,2})\]\s+(.*)$/;
const RESOURCE_TYPE = /^(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+(?:::[A-Za-z0-9]+)*)(?:\s+(.*))?$/;
const IMPACT = /\s*\b(may be replaced|replace|destroy|orphan|import)$/;
const MOVE = /\s*\(OR move .*\)$/;
const LOGICAL_ID = /^[A-Za-z0-9]+$/;
const REPLACING_PROPERTY = /\((?:requires|may cause) replacement\)/;
const HEADINGS: ReadonlySet<string> = new Set(["Template", "IAM Statement Changes", "IAM Policy Changes", "IAM Identity Center Changes", "Security Group Changes", "Parameters", "Metadata", "Mappings", "Conditions", "Resources", "Outputs", "Other Changes", "Resources In Sync", "Unchecked Resources"]);
const NO_DIFFERENCES = "There were no differences";
const GUARDED_NAME = new RegExp(`(?:${[...DATA_RESOURCE_TYPES].map((type) => type.replace(/:/g, "\\:")).join("|")})(?![A-Za-z0-9])`);
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

interface ResourceLine { mark: string; type: string; logicalId: string; impact: string }

function resourceLine(line: string): ResourceLine | undefined {
  const marked = MARK.exec(line);
  const typed = marked === null ? null : RESOURCE_TYPE.exec(marked[2] ?? "");
  if (marked === null || typed === null) return undefined;
  let rest = (typed[2] ?? "").replace(MOVE, "");
  const impact = IMPACT.exec(rest)?.[1] ?? "";
  rest = rest.replace(IMPACT, "").trim();
  const logicalId = rest.split(/\s+/).at(-1) ?? "";
  return { mark: marked[1] ?? "", type: typed[1] ?? "", logicalId: LOGICAL_ID.test(logicalId) ? logicalId : "", impact };
}

export function cdkDiffRisks(text: string): { data: DataChange[]; iam: boolean } {
  const data: DataChange[] = [];
  let iam = /IAM Statement Changes|IAM Policy Changes/.test(text);
  let section = "";
  let sawResources = false;
  // The resource the indented lines below belong to, and its replacement while not yet recorded.
  let resource: ResourceLine | undefined;
  let pending: DataChange | undefined;
  const unclear = (line: string, parsed?: ResourceLine) => data.push({ logicalId: parsed?.logicalId ?? "", type: parsed?.type ?? "", verb: "unclear", line });
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const plain = raw.replace(ANSI, "");
    const line = plain.trim();
    if (line === "") continue;
    const indented = /^\s/.test(plain);
    if (!indented && (HEADINGS.has(line) || line.startsWith("Stack "))) {
      section = line;
      if (line === "Resources") sawResources = true;
      resource = undefined;
      pending = undefined;
      continue;
    }
    if (indented || !MARK.test(line)) {
      // A property line, a JSON hunk line, or a multi-line value's continuation: detail of the resource above.
      if (resource?.type === "AWS::KMS::Key" && /^[├└]─ \[.\] KeyPolicy\b/.test(line)) iam = true;
      if (pending !== undefined && REPLACING_PROPERTY.test(line)) {
        data.push(pending);
        pending = undefined;
      }
      if (GUARDED_NAME.test(line)) unclear(line);
      continue;
    }
    // A column-0 marked line.
    resource = undefined;
    pending = undefined;
    if (section !== "Resources") {
      if (GUARDED_NAME.test(line)) unclear(line);
      continue;
    }
    const parsed = resourceLine(line);
    if (parsed === undefined || parsed.logicalId === "" || !["-", "~", "+", "←"].includes(parsed.mark)) {
      unclear(line, parsed);
      continue;
    }
    resource = parsed;
    if (isIamType(parsed.type)) iam = true;
    if (!DATA_RESOURCE_TYPES.has(parsed.type)) continue;
    const change = { logicalId: parsed.logicalId, type: parsed.type };
    if (parsed.mark === "-") data.push({ ...change, verb: parsed.impact === "orphan" ? "orphan" : "delete" });
    else if (parsed.mark === "~") {
      if (parsed.impact === "replace" || parsed.impact === "may be replaced") data.push({ ...change, verb: "replace" });
      else pending = { ...change, verb: "replace" };
    }
    // "+" adds and "←" imports: nothing is lost.
  }
  if (!sawResources && text.trim() !== "" && !text.includes(NO_DIFFERENCES)) {
    data.push({ logicalId: "", type: "", verb: "unclear", line: `no Resources section, and not "${NO_DIFFERENCES}"` });
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
