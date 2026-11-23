import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { transpileModule } from "typescript";
import { expect, it } from "vitest";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { HostCloseRetentionStorage } from "../../packages/worker/src/close-retention-storage.js";

const helper = readFileSync("packages/worker/ec2/close-retention.sh", "utf8");
const boot = readFileSync("packages/worker/ec2/boot.sh", "utf8");
// Execute main.ts's actual function without starting its top-level worker server.
const main = readFileSync("packages/worker/src/main.ts", "utf8");
const source = main.slice(main.indexOf("async function workerControlLayout("));
const compiled = transpileModule(source, { compilerOptions: { target: 9 } }).outputText;

it.each(["legacy", "low-space", "migrated"])("emitted %s env and mounts are accepted by main's real workerControlLayout", async (layout) => {
  const directory = mkdtempSync(join(tmpdir(), "close-retention-b1bis-layout-"));
  try {
    const generate = helper.slice(helper.indexOf("  mounts_tmp="), helper.indexOf("  systemd-run --unit=agentx-close-retention"));
    const result = spawnSync("bash", ["-euc", `HOST_RUN=$1; layout=$2\n# macOS mv lacks GNU -T; only the atomic-publish command is adapted.\nmv() { command mv -f "$2" "$3"; }\n${generate}\nargs=(); MOUNT_PATH=/mnt/workspace\n# Socket readiness is covered separately; consume the actual emitted argument lines here.\ntail -n +2 "$HOST_RUN/worker-mounts" > "$HOST_RUN/args"\nsource "$HOST_RUN/args"\nprintf '%s\\0' "\${args[@]}"`, "layout", directory, layout === "migrated" ? layout : "legacy"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const refusal = `emitted ${layout} env and mounts are accepted by main`;
    const args = result.stdout.split("\0").filter(Boolean);
    const env: Record<string, string> = { AGENTX_WORKSPACE_ROOT: boot.match(/^AGENTX_WORKSPACE_ROOT=(.+)$/mu)![1]!.replace("$MOUNT_PATH", "/mnt/workspace") };
    args.forEach((arg, i) => { if (arg === "--env") { const [key, value] = args[i + 1]!.split("="); env[key!] = value!; } });
    const migrated = layout === "migrated";
    expect(env.AGENTX_WORKSPACE_ROOT, refusal).toBe(migrated ? "/mnt/workspace/data" : "/mnt/workspace");
    expect(env.AGENTX_CONTROL_ROOT, refusal).toBe(migrated ? "/mnt/agentx-control" : undefined);
    expect(args, refusal).toContain(migrated ? "/run/agentx-close-retention/view:/mnt/workspace:rslave" : "/mnt/workspace:/mnt/workspace");
    expect(args.includes("type=bind,src=/run/agentx-close-retention/journal,dst=/mnt/agentx-control,bind-propagation=rprivate"), refusal).toBe(migrated);
    // Only filesystem/socket boundaries are redirected; journal behavior and layout validation are production code.
    class Journal extends OperationJournal { constructor(root: string, control?: string) { super(join(directory, root), control === undefined ? undefined : join(directory, control)); } }
    class Storage extends HostCloseRetentionStorage {
      override async withOwnership<T>(_mode: "read" | "write", work: () => Promise<T>): Promise<T> { return work(); }
      override async identity() { return { sessionGeneration: 3, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: "11111111-1111-4111-8111-111111111111" }; }
    }
    const controlLayout = runInNewContext(compiled + "\nworkerControlLayout", { OperationJournal: Journal, HostCloseRetentionStorage: Storage }) as (root: string, control: string | undefined, generation: number) => Promise<{ journal: OperationJournal; closeStorage: HostCloseRetentionStorage | undefined; retainedAtBoot: boolean }>;
    const resultLayout = controlLayout(env.AGENTX_WORKSPACE_ROOT!, env.AGENTX_CONTROL_ROOT, 3);
    await expect(resultLayout, refusal).resolves.toBeDefined();
    const accepted = await resultLayout;
    expect(accepted.journal.directory, refusal).toBe(join(directory, migrated ? "/mnt/agentx-control" : "/mnt/workspace", ".agentx/operations"));
    expect(accepted.closeStorage !== undefined, refusal).toBe(migrated);
    expect(accepted.retainedAtBoot, refusal).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
