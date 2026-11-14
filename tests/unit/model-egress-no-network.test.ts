// TE-F1a: this lane's share of the required test "no request reaches a real model host" (the helper and network halves are F1-b and F1-g). The whole conformance suite runs on the fake adapter under a tripwire that fails on any socket,
// DNS lookup, http(s) request or fetch to a non-loopback address; the suite's own transport asserts that every call's destination host is the row's host. Then the "no callers" proof: nothing outside the contracts and testing packages
// uses the new files yet.
import { createServer } from "node:http";
import net from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import dns from "node:dns";
import https from "node:https";
import { describe, expect, it } from "vitest";
import { installNetworkTripwire, withNetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { modelEgressChecks } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { FIXTURE_AZURE_HOST } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { fakeModelEgressWorld } from "../../packages/testing/src/ports/model-egress-world.js";

describe("the tripwire sees every door", () => {
  it("refuses and records a socket, a DNS lookup, an https request, an http request and a fetch to a real model host", async () => {
    const tripwire = installNetworkTripwire();
    try {
      expect(() => net.connect({ host: "generativelanguage.googleapis.com", port: 443 })).toThrow(/tripwire/u);
      expect(() => net.connect(443, "93.184.216.34")).toThrow(/tripwire/u);
      expect(() => dns.lookup("api.openai.com", () => undefined)).toThrow(/tripwire/u);
      expect(() => https.request("https://api.anthropic.com/v1/messages")).toThrow(/tripwire/u);
      await expect(fetch("https://openrouter.ai/api/v1/chat/completions")).rejects.toThrow(/tripwire/u);
    } finally {
      tripwire.restore();
    }
    expect(tripwire.attempts.map((entry) => entry.door).sort()).toEqual(["dns", "fetch", "https", "socket", "socket"]);
    expect(tripwire.attempts.filter((entry) => entry.door === "socket").map((entry) => entry.target).sort()).toEqual(["93.184.216.34", "generativelanguage.googleapis.com"]);
    expect(tripwire.attempts.map((entry) => entry.target)).toEqual(expect.arrayContaining(["generativelanguage.googleapis.com", "api.openai.com", "api.anthropic.com", "openrouter.ai", "93.184.216.34"]));
  });
  it("lets loopback through, so the tripwire does not break local test servers", async () => {
    const server = createServer((_, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const outcome = await withNetworkTripwire(async () => (await fetch(`http://127.0.0.1:${String(port)}/`)).text());
    server.close();
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toBe("ok");
    expect(outcome.attempts).toEqual([]);
  });
  it("restores everything, and cannot be installed twice", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- only compared by identity, never called
    const connect = net.Socket.prototype.connect;
    const first = installNetworkTripwire();
    expect(() => installNetworkTripwire()).toThrow(/already installed/u);
    first.restore();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- only compared by identity, never called
    expect(net.Socket.prototype.connect).toBe(connect);
    const again = installNetworkTripwire();
    again.restore();
  });
});

describe("no request reaches a real model host", () => {
  it("runs the whole conformance suite under the tripwire: zero attempts, and every transport call went to its row's own host", async () => {
    const outcome = await withNetworkTripwire(async () => {
      const destinations = new Set<string>();
      for (const check of modelEgressChecks) {
        const world = fakeModelEgressWorld();
        if (check.needs !== undefined && !check.needs(world)) continue;
        await check.run(world);
        for (const call of world.provider.calls) destinations.add(call.host);
      }
      return destinations;
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.attempts).toEqual([]);
    // The providers' real hosts appear only as the DESTINATION the transport was handed, never as a connection.
    const rows = Object.values(fakeModelEgressWorld().rows);
    const known = new Set([...rows.flatMap((row) => row.hosts), FIXTURE_AZURE_HOST]);
    for (const host of outcome.result ?? []) expect(known.has(host), host).toBe(true);
    expect((outcome.result ?? new Set()).size).toBeGreaterThan(3);
  });
  it("a defective adapter that takes the host from the client is caught at the transport", async () => {
    const failed: string[] = [];
    for (const check of modelEgressChecks) {
      const world = fakeModelEgressWorld("host_from_frame");
      if (check.needs !== undefined && !check.needs(world)) continue;
      try {
        await check.run(world);
      } catch {
        failed.push(check.name);
      }
    }
    expect(failed.some((name) => /no host but the row's/u.test(name))).toBe(true);
  });
});

describe("no callers yet", () => {
  const NEW_NAMES = /model-egress|buildOutboundRequest|routeEgressRequest|ModelEgress[A-Z]|MODEL_EGRESS|evidenceLinesFor|parseModelEgress|createFakeEgress|scrubResponseBody|createKeyEchoScanner|planConnection|runModelEgress/u;
  const root = join(__dirname, "..", "..");
  const walk = (directory: string, found: string[] = []): string[] => {
    for (const name of readdirSync(directory)) {
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path, found);
      else if (/\.(?:ts|tsx|js|mjs|cjs|json)$/u.test(name)) found.push(path);
    }
    return found;
  };
  it("nothing outside packages/contracts and packages/testing (and tests) names the new files or their exports", () => {
    const outside: string[] = [];
    for (const dir of ["packages", "scripts", "infra", "local", "vendor"]) {
      const files: string[] = [];
      try {
        walk(join(root, dir), files);
      } catch {
        continue;
      }
      for (const file of files) {
        const relative = file.slice(root.length + 1);
        if (relative.startsWith("packages/contracts/") || relative.startsWith("packages/testing/")) continue;
        // F0a's own barrel and tests are not callers of this lane.
        if (NEW_NAMES.test(readFileSync(file, "utf8"))) outside.push(relative);
      }
    }
    expect(outside).toEqual([]);
  });
});
