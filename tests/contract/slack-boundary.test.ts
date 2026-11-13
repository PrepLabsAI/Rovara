// Spec 062 SC-004 (Phase 5b): Slack is an adapter by module boundary. The conversation core — the orchestrator, the
// request processor and its texts, the queue runner, the channel modules and the broker's conversation identity —
// imports no Slack type and no Slack module. What only Slack has lives in Slack's modules. The rest of the codebase,
// where Slack is a product feature (developer tasks shared to Slack, Slack sign-in, eval batches), may only shrink its
// Slack imports.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SERVICE = "packages/slack-service/src";

/** The conversation core. A new core module belongs here. */
const CORE = [
  ...tsFiles("packages/orchestrator/src"),
  ...[
    "processor", "consumer", "channel-requests", "conversation-format", "confirmations", "confirmation-store", "lazy-worker",
    "messages", "model-command", "shared-task", "interrupted-turn", "progress-note", "ids", "active-turn-store", "runtime",
    "thread-api", "thread-workspace-request",
  ].map((name) => `${SERVICE}/${name}.ts`),
  ...["channel-adapters", "channel-conversation", "channel-events", "channel-ingress", "channel-link-web", "channel-links"].map((name) => `packages/core/src/aws/${name}.ts`),
];

/** Slack's own modules in the orchestrator service, besides every `slack-*.ts`; main.ts composes both sides. */
const SLACK_MODULES = new Set(["main", "turn-records", "eval-batch-watcher", "eval-batch-command", "swebench-command", "request-routing", "task-question", "page-comment", "user-names", "signing-fetch"]);

/**
 * Files outside the core and Slack's modules that import a Slack-named contract today. Lower it when one goes; a new
 * one fails this test (spec 062: design new surfaces against the neutral model).
 */
const OTHER_SLACK_IMPORTERS_MAX = 40;

function tsFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

interface ImportUse { specifier: string; names: string[] }

/** Every static import and re-export, with the names it brings in. */
function importsOf(file: string): ImportUse[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const uses: ImportUse[] = [];
  for (const match of source.matchAll(/^(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm)) {
    const clause = match[2] ?? "";
    const names = [...clause.matchAll(/\b([A-Za-z_$][\w$]*)\b(?:\s+as\s+[\w$]+)?/g)].map((name) => name[1]!).filter((name) => name !== "type" && name !== "as");
    uses.push({ specifier: match[3]!, names });
  }
  return uses;
}

/** SLACK_CHANNEL is the neutral model's reserved channel ID, which no adapter may claim; it is not a Slack type. */
const NEUTRAL_NAMES = new Set(["SLACK_CHANNEL"]);
const isSlackName = (name: string) => /slack/i.test(name) && !NEUTRAL_NAMES.has(name);

function isSlackModule(from: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(join(ROOT, from)), specifier);
  const name = basename(target).replace(/\.js$/, "");
  return name.startsWith("slack-") || name === "slack" || (relative(ROOT, dirname(target)) === SERVICE && SLACK_MODULES.has(name));
}

function slackUses(file: string): string[] {
  return importsOf(file).flatMap((use) => [
    ...(isSlackModule(file, use.specifier) ? [`imports Slack module ${use.specifier}`] : []),
    ...(use.specifier === "@rovara-code/contracts" || use.specifier.includes("/contracts/") ? use.names.filter(isSlackName).map((name) => `imports ${name} from ${use.specifier}`) : []),
  ]);
}

describe("the Slack boundary (spec 062 SC-004)", () => {
  it("lists only core files that exist", () => {
    for (const file of CORE) expect(() => readFileSync(join(ROOT, file)), file).not.toThrow();
  });

  it("keeps Slack types and Slack modules out of the conversation core", () => {
    const violations = CORE.flatMap((file) => slackUses(file).map((use) => `${file}: ${use}`));
    expect(violations).toEqual([]);
  });

  it("does not grow Slack imports elsewhere", () => {
    const core = new Set(CORE);
    const others = ["packages/core/src", "packages/slack-service/src", "packages/gateway/src", "packages/cli/src", "packages/worker/src", "packages/mcp/src"]
      .flatMap((directory) => tsFiles(directory))
      .filter((file) => !core.has(file))
      .filter((file) => !basename(file).startsWith("slack-") && !(dirname(file) === SERVICE && SLACK_MODULES.has(basename(file, ".ts"))))
      .filter((file) => importsOf(file).some((use) => (use.specifier === "@rovara-code/contracts" || use.specifier.includes("/contracts/")) && use.names.some(isSlackName)));
    expect(others.length, others.join("\n")).toBeLessThanOrEqual(OTHER_SLACK_IMPORTERS_MAX);
  });

  it("finds a Slack import where there is one", () => {
    expect(slackUses(`${SERVICE}/slack-processor.ts`)).toContain("imports SlackRequestMessage from @rovara-code/contracts");
    expect(slackUses(`${SERVICE}/main.ts`)).toContain("imports Slack module ./slack-processor.js");
  });
});
