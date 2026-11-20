import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/contracts/src/egress-gateway-source.js";
import { F11_ALLOWED_TARGETS, f11GatewaySource, probeF11Dns, probeF11Navigation, probeF11Targets, snapshotF11Diagnostics, withF11FailureDiagnostics, type ProbePage } from "../support/f11-diagnostics.js";

interface FakeRequest { url(): string; failure(): { errorText: string } | null; redirectedFrom(): FakeRequest | null }
const request = (url: string, errorText: string | null = null, previous: FakeRequest | null = null): FakeRequest => ({
  url: () => url, failure: () => errorText === null ? null : { errorText }, redirectedFrom: () => previous,
});
const response = (url: string, status: number, req = request(url)) => ({ url: () => url, status: () => status, request: () => req });
class Page extends EventEmitter implements ProbePage {
  visits: Array<{ url: string; options: unknown }> = [];
  constructor(readonly navigate: (page: Page, url: string) => ReturnType<ProbePage["goto"]>, readonly body = "{}") { super(); }
  async goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }) {
    this.visits.push({ url, options });
    return this.navigate(this, url);
  }
  async close() {}
  locator() { return { innerText: async () => this.body }; }
}
// Exercise the exact serialization used by the real-Docker probe too.
const probe = runInNewContext(`(${probeF11Navigation.toString()})`) as typeof probeF11Navigation;
const probeTargets = runInNewContext(`(${probeF11Targets.toString()})`) as typeof probeF11Targets;

describe("F11 Chromium diagnostics (offline fakes)", () => {
  it("isolates target navigations so a denied host cannot interrupt the next goto", async () => {
    class ChromiumPage extends Page {
      errorPage = false;
      constructor() {
        super(async (page, url) => {
          if ((page as ChromiumPage).errorPage) throw new Error("Navigation interrupted by chrome-error://chromewebdata/");
          if (url.includes("denied.example")) {
            (page as ChromiumPage).errorPage = true;
            throw new Error("net::ERR_TUNNEL_CONNECTION_FAILED");
          }
          const ok = response(url, 200);
          page.emit("response", ok);
          return ok;
        });
      }
    }
    class ChromiumBrowser {
      readonly pages: ChromiumPage[] = [];
      async newPage() { const page = new ChromiumPage(); this.pages.push(page); return page; }
    }
    const browser = new ChromiumBrowser();
    const targets = ["https://denied.example/", "https://allowed.example/"];
    const oldSharedPage = await browser.newPage();
    const oldResults = [];
    for (const url of targets) oldResults.push(await probe(oldSharedPage, url, 1000));
    expect(oldResults[1]).toMatchObject({ error: "Navigation interrupted by chrome-error://chromewebdata/" });

    const newBrowser = new ChromiumBrowser();
    const results = await probeTargets(newBrowser, targets, probe, () => 1000);
    expect(results.map((result) => result.status ?? null)).toEqual([null, 200]);
    expect(newBrowser.pages).toHaveLength(2);
    expect(newBrowser.pages[0]).not.toBe(newBrowser.pages[1]);
  });

  it("retains the real requestfailed error when goto reports only chrome-error interruption, without retrying", async () => {
    const page = new Page(async (p, url) => {
      p.emit("requestfailed", request(url, "net::ERR_CERT_AUTHORITY_INVALID"));
      throw new Error('Navigation interrupted by chrome-error://chromewebdata/');
    });
    const result = await probe(page, F11_ALLOWED_TARGETS.allowed, 20_000);
    expect(result).toMatchObject({ error: 'Navigation interrupted by chrome-error://chromewebdata/', requestFailures: [{ url: "https://registry.npmjs.org/-/ping", errorText: "net::ERR_CERT_AUTHORITY_INVALID" }] });
    expect(page.visits).toEqual([{ url: "https://registry.npmjs.org/-/ping", options: { waitUntil: "domcontentloaded", timeout: 20_000 } }]);
    expect(page.listenerCount("requestfailed")).toBe(0);
    expect(page.listenerCount("response")).toBe(0);
  });

  it("retains response statuses and the redirect chain before a redirected host fails", async () => {
    const page = new Page(async (p, url) => {
      const first = request(url);
      const next = request("https://elsewhere.example/final", "net::ERR_NAME_NOT_RESOLVED", first);
      p.emit("response", response(url, 302, first));
      p.emit("response", response("https://elsewhere.example/final", 307, next));
      p.emit("requestfailed", next);
      throw new Error("navigation failed");
    });
    expect(await probe(page, "https://github.com/", 20_000)).toMatchObject({
      responses: [{ url: "https://github.com/", status: 302, redirects: [] }, { url: "https://elsewhere.example/final", status: 307, redirects: ["https://github.com/"] }],
      requestFailures: [{ url: "https://elsewhere.example/final", errorText: "net::ERR_NAME_NOT_RESOLVED" }],
    });
  });

  it("preserves a non-200 response for strict assertions and probes the second allowed HTTPS host", async () => {
    const page = new Page(async (p, url) => { const r = response(url, 503); p.emit("response", r); return r; }, "upstream unavailable");
    expect(await probe(page, F11_ALLOWED_TARGETS.allowedSecond, 20_000)).toMatchObject({ status: 503, body: "upstream unavailable", responses: [{ url: "https://github.com/", status: 503, redirects: [] }], requestFailures: [] });
    expect(page.listenerCount("response")).toBe(0);
  });

  it("reports body-read failures without discarding the HTTP response", async () => {
    const page = new Page(async (p, url) => { const r = response(url, 200); p.emit("response", r); return r; });
    page.locator = () => ({ innerText: async () => { throw new Error("renderer closed"); } });
    expect(await probe(page, "https://github.com/", 20_000)).toMatchObject({ error: "renderer closed", responses: [{ status: 200 }] });
  });
});

describe("F11 failure dump", () => {
  it("dumps gateway, sandbox DNS and probe output on any thrown failure, then rethrows the original", async () => {
    const error = new Error("listener assertion failed");
    const output: string[] = [];
    await expect(withF11FailureDiagnostics(async () => { throw error; }, {
      gateway: async () => ({ stdout: '{"event":"f11_tls_sni","host":"registry.npmjs.org"}', stderr: "gateway stderr" }),
      sandboxDns: async () => ({ addresses: ["172.28.250.2"] }),
      chromium: async () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
    }, (line) => output.push(line))).rejects.toBe(error);
    expect(output.join("\n")).toContain("registry.npmjs.org");
    expect(output.join("\n")).toContain("gateway stderr");
    expect(output.join("\n")).toContain("172.28.250.2");
    expect(output.join("\n")).toContain("net::ERR_CONNECTION_RESET");
  });

  it("keeps collecting after a diagnostic command fails and preserves the original failure", async () => {
    const original = new Error("capture failed");
    const output: string[] = [];
    await expect(withF11FailureDiagnostics(async () => { throw original; }, {
      gateway: async () => { throw new Error("docker logs unavailable"); },
      sandboxDns: async () => "resolver evidence",
    }, (line) => output.push(line))).rejects.toBe(original);
    expect(output.join("\n")).toContain("docker logs unavailable");
    expect(output.join("\n")).toContain("resolver evidence");
  });

  it("keeps DNS and probe evidence for a cleanup failure after their containers are removed", async () => {
    let containersExist = true;
    const saved = await snapshotF11Diagnostics({
      sandboxDns: async () => { if (!containersExist) throw new Error("sandbox removed"); return { ipv4: ["172.28.250.2"], ipv6: [] }; },
      chromium: async () => { if (!containersExist) throw new Error("probe removed"); return "net::ERR_CONNECTION_RESET"; },
      gateway: async () => { throw new Error("gateway log unavailable"); },
    });
    const output: string[] = [];
    const original = new Error("cleanup route removal failed");
    await expect(withF11FailureDiagnostics(async () => { containersExist = false; throw original; }, saved, (line) => output.push(line))).rejects.toBe(original);
    expect(output.join("\n")).toContain("172.28.250.2");
    expect(output.join("\n")).toContain('"ipv6": []');
    expect(output.join("\n")).toContain("net::ERR_CONNECTION_RESET");
    expect(output.join("\n")).toContain("gateway log unavailable");
    expect(output.join("\n")).not.toContain("sandbox removed");
    expect(output.join("\n")).not.toContain("probe removed");
  });

  it("does not collect diagnostics or change a successful result", async () => {
    expect(await withF11FailureDiagnostics(async () => 42, { gateway: async () => { throw new Error("must not run"); } }, () => { throw new Error("must not write"); })).toBe(42);
  });
});

// A minimal ClientHello with a single SNI extension; no sockets or DNS leave this process.
function hello(host: string): Buffer {
  const name = Buffer.from(host);
  const lengths = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const entry = Buffer.concat([Buffer.from([0]), lengths(name.length), name]);
  const sni = Buffer.concat([lengths(entry.length), entry]);
  const extension = Buffer.concat([Buffer.from([0, 0]), lengths(sni.length), sni]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0x13, 1, 1, 0]), lengths(extension.length), extension]);
  const header = Buffer.from([1, 0, 0, 0]); header.writeUIntBE(body.length, 1, 3);
  const record = Buffer.concat([header, body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), lengths(record.length), record]);
}

describe("F11 gateway SNI instrumentation", () => {
  it("logs the SNI actually parsed even when policy refuses it, retaining the refusal", () => {
    let accept: (client: EventEmitter & { remoteAddress: string; destroy(): void }) => void = () => { throw new Error("not listening"); };
    const server = new EventEmitter() as EventEmitter & { listen(): void }; server.listen = () => {};
    const output: string[] = [];
    const module = { exports: {} as { startTlsForwarder(ip: string, cidr: string, role: string): void } };
    const require = createRequire(import.meta.url);
    runInNewContext(f11GatewaySource(EGRESS_GATEWAY_SOURCE), {
      Buffer, module, setTimeout: () => 0, clearTimeout: () => {},
      process: { env: { ROVARA_GW_LIBRARY: "1", ROVARA_GW_CONFIG: JSON.stringify({ allowed: ["ghcr.io"], sandboxDenied: ["ghcr.io"] }) }, stdout: { write: (line: string) => output.push(line) } },
      require: (id: string) => id === "net" ? { createServer: (handler: typeof accept) => { accept = handler; return server; } } : require(id) as unknown,
    });
    module.exports.startTlsForwarder("172.28.250.2", "172.28.250.0/24", "sandbox");
    let destroyed = false;
    const client = Object.assign(new EventEmitter(), { remoteAddress: "172.28.250.16", destroy: () => { destroyed = true; } });
    accept(client);
    client.emit("data", hello("ghcr.io"));
    expect(output.map((line) => JSON.parse(line) as unknown)).toContainEqual({ event: "f11_tls_sni", port: 443, host: "ghcr.io", error: null, more: false });
    expect(destroyed).toBe(true);
  });

  it("fails closed if the instrumentation anchor changes or is ambiguous", () => {
    expect(() => f11GatewaySource("different gateway")).toThrow("F11 TLS diagnostic anchor");
    expect(() => f11GatewaySource(EGRESS_GATEWAY_SOURCE + EGRESS_GATEWAY_SOURCE)).toThrow("F11 TLS diagnostic anchor");
  });
});

it("F11 DNS dump retains each host's IPv4 and IPv6 answer or resolver error", async () => {
  const resolver = {
    resolve4: async (host: string) => { if (host === "github.com") throw Object.assign(new Error("no answer"), { code: "ENOTFOUND" }); return ["172.28.250.2"]; },
    resolve6: async () => [] as string[],
  };
  const dnsProbe = runInNewContext(`(${probeF11Dns.toString()})`) as typeof probeF11Dns;
  expect(await dnsProbe(resolver, ["registry.npmjs.org", "github.com"])).toEqual({
    "registry.npmjs.org": { ipv4: { addresses: ["172.28.250.2"] }, ipv6: { addresses: [] } },
    "github.com": { ipv4: { error: "ENOTFOUND" }, ipv6: { addresses: [] } },
  });
});
