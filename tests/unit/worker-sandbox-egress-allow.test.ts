// L4-NETG follow-up (DEC 254zzz90): the worker publishes the project's exact S3 hosts for the host's egress gateway, on a gateway-mode worker only, and never as anything but a small plain file of exact names.
import { lstat, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EGRESS_ALLOW_DIRECTORY, EGRESS_ALLOW_FILE, publishEgressS3Allow } from "../../packages/worker/src/sandbox-egress-allow.js";
import { EgressS3AllowSchema } from "../../packages/contracts/src/sandbox-deny-domains.js";

const GATEWAY = { AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway", AGENTX_SANDBOX_NETWORK: "rovara-snet", AGENTX_SANDBOX_DNS: "172.28.250.2" } as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
const folder = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), "egress-allow-")); roots.push(d); return d; };
const exists = (path: string) => lstat(path).then(() => true, () => false);

describe("publishEgressS3Allow", () => {
  it("writes the exact hosts, sorted, once, as a small plain file, and rewrites it at the next prepare (a host that left the project leaves the file)", async () => {
    const dir = await folder();
    expect(await publishEgressS3Allow(["b.s3.us-west-2.amazonaws.com", "a.s3.us-west-2.amazonaws.com", "a.s3.us-west-2.amazonaws.com"], GATEWAY, dir)).toBe("published");
    expect(JSON.parse(await readFile(join(dir, "project-allow.json"), "utf8"))).toEqual({ hosts: ["a.s3.us-west-2.amazonaws.com", "b.s3.us-west-2.amazonaws.com"] });
    expect(await publishEgressS3Allow(["b.s3.us-west-2.amazonaws.com"], GATEWAY, dir)).toBe("published");
    expect(JSON.parse(await readFile(join(dir, "project-allow.json"), "utf8"))).toEqual({ hosts: ["b.s3.us-west-2.amazonaws.com"] });
    expect(await publishEgressS3Allow(undefined, GATEWAY, dir)).toBe("cleared");
    expect(await exists(join(dir, "project-allow.json"))).toBe(false);
  });

  it("writes nothing that is not an exact S3 host (a wildcard, a registry, another AWS name), and clears the file when nothing is left", async () => {
    const dir = await folder();
    expect(await publishEgressS3Allow(["*.s3.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com", "ghcr.io", "dynamodb.us-west-2.amazonaws.com", "A.s3.us-west-2.amazonaws.com"], GATEWAY, dir)).toBe("cleared");
    expect(await exists(join(dir, "project-allow.json"))).toBe(false);
  });

  it("does nothing off a gateway-mode worker (a laptop, a bridge-mode worker): no file, no folder touched", async () => {
    const dir = await folder();
    for (const environment of [{}, { AGENTX_RUNTIME: "ec2" }, { ...GATEWAY, AGENTX_SANDBOX_EGRESS: "bridge" }]) expect(await publishEgressS3Allow(["a.s3.us-west-2.amazonaws.com"], environment, dir)).toBe("skipped");
    expect(await exists(join(dir, "project-allow.json"))).toBe(false);
  });

  it("fails soft and removes any stale file when the folder is missing or is a link (S3 stays denied)", async () => {
    const dir = await folder();
    expect(await publishEgressS3Allow(["a.s3.us-west-2.amazonaws.com"], GATEWAY, join(dir, "absent"))).toBe("failed");
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    expect(await publishEgressS3Allow(["a.s3.us-west-2.amazonaws.com"], GATEWAY, join(dir, "link"))).toBe("failed");
    expect(await exists(join(dir, "real", "project-allow.json"))).toBe(false);
  });

  it("the fixed path is the one the boot stage makes and mounts, and the payload schema takes only exact S3 hosts", async () => {
    expect(EGRESS_ALLOW_FILE).toBe(`${EGRESS_ALLOW_DIRECTORY}/project-allow.json`);
    const stage = await readFile(new URL("../../packages/worker/ec2/sandbox-egress.sh", import.meta.url), "utf8");
    expect(stage).toContain(`readonly SE_ALLOW_FILE=${EGRESS_ALLOW_FILE}`);
    expect(await readFile(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8")).toContain(`t=${EGRESS_ALLOW_DIRECTORY}; [[ ! -d $t ]] || args+=(--volume $t:$t)`);
    const schema = EgressS3AllowSchema;
    expect(schema.safeParse(["a.s3.us-west-2.amazonaws.com"]).success).toBe(true);
    for (const bad of [["*.s3.us-west-2.amazonaws.com"], ["ghcr.io"], ["A.s3.amazonaws.com"], Array.from({ length: 51 }, (_, i) => `b${String(i)}.s3.amazonaws.com`)]) expect(schema.safeParse(bad).success).toBe(false);
  });
});
