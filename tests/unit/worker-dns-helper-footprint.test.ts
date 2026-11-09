// The DNS helper containers (the setup run's watch and the sealed round's name server) run the worker's own image under a 128 MB memory limit (setup-network.ts `helperRunArgs`, check-sandbox.ts
// `sealedDnsHelperRunArgs`). Loading the whole `@agentx/contracts` barrel takes about 210 MB of RSS, and on linux-runtime (CI 41791561884) the sealed helper was OOM-killed (exit 137, oom=true) before it
// bound .2:53, so every sealed lookup failed. The helpers' modules therefore import only node built-ins, each other, and the small `@agentx/contracts/dns-helper` entry, which loads about 55 MB.
// The limit stays: the helper sits on a network an untrusted program can reach. These tests pin what the helpers load, measure the contracts part, and pin the limit.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sealedDnsHelperRunArgs } from "../../packages/worker/src/check-sandbox.js";
import { runNetworkAddresses, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";

/** The specifiers a TypeScript source imports (static `import ... from`, `export ... from` and dynamic `import()`); `import type` is erased at build, so it is left out. */
function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gmu)) found.push(match[1]!);
  for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu)) found.push(match[1]!);
  return found;
}

const HELPER_MODULES = ["packages/worker/src/sealed-dns-helper.ts", "packages/worker/src/setup-dns-watch-helper.ts", "packages/worker/src/setup-dns-watch.ts"];
const ALLOWED = new Set(["./setup-dns-watch.js", "@agentx/contracts/dns-helper"]);

describe("the DNS helpers load little enough for their 128 MB limit", () => {
  it("the helpers' modules import only node built-ins, each other and @agentx/contracts/dns-helper (never the barrel)", async () => {
    for (const path of HELPER_MODULES) {
      const specifiers = importsOf(await readFile(path, "utf8"));
      expect(specifiers.length, path).toBeGreaterThan(0);
      expect(specifiers.filter((specifier) => !specifier.startsWith("node:") && !ALLOWED.has(specifier)), path).toEqual([]);
    }
  });

  it("the contracts entry loads only its two small modules, and they load only zod", async () => {
    expect(importsOf(await readFile("packages/contracts/src/dns-helper.ts", "utf8")).sort()).toEqual(["./errors.js", "./setup-run.js"]);
    for (const path of ["packages/contracts/src/errors.ts", "packages/contracts/src/setup-run.ts"]) expect(importsOf(await readFile(path, "utf8")), path).toEqual(["zod"]);
    const manifest = JSON.parse(await readFile("packages/contracts/package.json", "utf8")) as { exports: Record<string, string> };
    expect(manifest.exports["./dns-helper"]).toBe("./dist/dns-helper.js");
  });

  it("measured: node with the contracts entry stays far below the limit, and the barrel would not", () => {
    const peak = (specifier: string): number => {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)}); console.log(process.resourceUsage().maxRSS);`], { encoding: "utf8", timeout: 60_000 });
      expect(child.status, child.stderr).toBe(0);
      return Number(child.stdout.trim()) / 1024;
    };
    const lean = peak("@agentx/contracts/dns-helper");
    // About 55 MB measured (node 22.23.2); the node process alone is about 40 MB. Under 96 MB leaves the helper's sockets and record room inside 128 MB.
    expect(lean).toBeLessThan(96);
    // The barrel is the reason for the entry: if it ever became small, this test should be revisited, not the limit raised.
    expect(peak("@agentx/contracts")).toBeGreaterThan(lean + 50);
  });

  it("both helpers keep a 128 MB cap with swap at the same size (the limit is kept, not removed)", () => {
    const slot = 5;
    const addresses = runNetworkAddresses(slot);
    const args = sealedDnsHelperRunArgs({
      net: {
        name: runNetworkName("11111111-1111-4111-8111-111111111111"), slot, subnet: addresses.subnet, dnsHelperIp: addresses.dnsHelperIp, workingSandboxIp: addresses.workingSandboxIp, checkSandboxIp: addresses.checkSandboxIp,
        labelArgs: () => runNetworkLabelArgs({ runId: "11111111-1111-4111-8111-111111111111", workspace: "0123456789abcdef", createdAt: 1_800_000_000_000, expiresAt: 1_800_000_900_000 }),
      },
      image: "worker@sha256:" + "a".repeat(64), helpers: [{ alias: "postgres", address: runNetworkHelperIp(slot, 0) }], sinkholeIp: runNetworkHelperIp(slot, 31),
    });
    expect(args[args.indexOf("--memory") + 1]).toBe("128m");
    expect(args[args.indexOf("--memory-swap") + 1]).toBe("128m");
  });
});
