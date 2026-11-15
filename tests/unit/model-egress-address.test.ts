// TE-F1a: the address checks are a COPY of the worker's (`packages/worker/src/test-account-proxy.ts`): the same truth table, then the resolve-check rule.
import { describe, expect, it } from "vitest";
import { MODEL_EGRESS_DENIED_SUFFIXES, isForbiddenAddress, lookupNameFor, looksLikeAddress, planConnection, proxyHostName } from "@agentx/contracts";
import * as worker from "../../packages/worker/src/test-account-proxy.js";

const ADDRESSES = [
  "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255", "172.15.0.1", "172.16.0.1", "172.31.255.255", "172.32.0.1", "192.168.0.1", "192.167.0.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "100.128.0.1",
  "0.0.0.0", "0.1.2.3", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.255.255", "198.20.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "8.8.8.8", "1.1.1.1",
  "142.250.80.42", "93.184.216.34", "::", "::1", "::2", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:0:0", "::ffff:7f00:1", "64:ff9b::1", "64:ff9b::808:808", "64:ff9b:1::1", "100::1", "100::", "2001::1", "2001:db8::1", "2002::1",
  "2002:7f00:1::", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::abcd%eth0", "fec0::1", "ff02::1", "2607:f8b0:4004:c07::6a", "2a00:1450:4001:81b::200e", "2001:4860:4860::8888", "0:0:0:0:0:0:0:1", "::127.0.0.1", "::8.8.8.8",
  "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.1.1.1", "0x7f.0.0.1", "2130706433", "localhost", "", " ", "1.1.1.1 ", "[::1]", "example.com", "not an address", "::g", "12345::1",
];
const HOSTS = [
  "generativelanguage.googleapis.com", "api.openai.com", "openrouter.ai", "a.b", "a", "localhost", "LOCALHOST", "Example.COM", "example.com.", "example.com..", "127.0.0.1", "127.1", "0x7f.1", "2130706433", "1.2.3.4", "[::1]", "::1", "a:b",
  "xn--bcher-kva.example", "-bad.example.com", "bad-.example.com", "a".repeat(64) + ".example.com", "a".repeat(63) + ".example.com", `${"a.".repeat(130)}com`, "exa mple.com", "example.com/path", "user@example.com", "example.com:443", "exa%6dple.com",
  "foo.0x7f", "foo.123", "foo.bar1", "1.2.3.4.example.com", "10.0.0.1.nip.io", "", ".", ".example.com", "internal", "metadata.google.internal", "café.example.com", "é.example.com", "EXAMPLE.com", "x.y.z.example.org",
];

describe("the address checks are the worker's, to one truth table", () => {
  for (const address of ADDRESSES) {
    it(`isForbiddenAddress(${JSON.stringify(address)})`, () => {
      expect(isForbiddenAddress(address)).toBe(worker.isForbiddenAddress(address));
    });
  }
  for (const host of HOSTS) {
    it(`proxyHostName and looksLikeAddress(${JSON.stringify(host.length > 40 ? `${host.slice(0, 20)}...` : host)})`, () => {
      expect(proxyHostName(host)).toBe(worker.proxyHostName(host));
      expect(looksLikeAddress(host)).toBe(worker.looksLikeAddress(host));
    });
  }
  it("agrees on 2000 generated IPv4 and IPv6 addresses", () => {
    let seed = 0x2f6e2b1;
    const next = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed);
    for (let index = 0; index < 1000; index += 1) {
      const four = [next() % 256, next() % 256, next() % 256, next() % 256].join(".");
      expect(isForbiddenAddress(four), four).toBe(worker.isForbiddenAddress(four));
      const six = Array.from({ length: 8 }, () => (next() % 3 === 0 ? "0" : (next() % 65536).toString(16))).join(":");
      expect(isForbiddenAddress(six), six).toBe(worker.isForbiddenAddress(six));
    }
  });
  it("forbids what Lambda's runtime API and the metadata service sit on, and IPv4-mapped IPv6", () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "::1", "fd00:ec2::254"]) expect(isForbiddenAddress(address), address).toBe(true);
    expect(isForbiddenAddress("8.8.8.8")).toBe(false);
    expect(isForbiddenAddress("2607:f8b0:4004:c07::6a")).toBe(false);
  });
});

describe("the resolve-check rule", () => {
  it("connects to the checked address with the row's host as the TLS name", () => {
    expect(planConnection("generativelanguage.googleapis.com", ["142.250.80.42"])).toEqual({ ok: true, address: "142.250.80.42", port: 443, scheme: "https", tlsServerName: "generativelanguage.googleapis.com", verifyCertificate: true, followRedirects: false });
    expect(planConnection("api.openai.com", ["2607:f8b0:4004:c07::6a", "142.250.80.42"])).toMatchObject({ ok: true, address: "2607:f8b0:4004:c07::6a" });
  });
  it("refuses the whole answer when ANY address in it is forbidden", () => {
    for (const answers of [["127.0.0.1"], ["8.8.8.8", "127.0.0.1"], ["127.0.0.1", "8.8.8.8"], ["8.8.8.8", "10.0.0.5"], ["::ffff:127.0.0.1"], ["8.8.8.8", "::1"], ["169.254.169.254"], ["not an address"], []]) {
      expect(planConnection("api.openai.com", answers), JSON.stringify(answers)).toEqual({ ok: false, refusal: "ssrf" });
    }
  });
  it("refuses a host that is an address or not a plain public name", () => {
    for (const host of ["127.0.0.1", "[::1]", "localhost", "API.OPENAI.COM", "api.openai.com.", "a b", "1.1.1.1", ""]) expect(planConnection(host, ["8.8.8.8"]), host).toEqual({ ok: false, refusal: "ssrf" });
  });
  it("refuses an absurdly long answer list", () => {
    expect(planConnection("api.openai.com", Array.from({ length: 65 }, () => "8.8.8.8"))).toEqual({ ok: false, refusal: "ssrf" });
  });
  it("refuses a host under a denied suffix (AWS's own domains, function URLs) and any suffix the caller adds, on every call", () => {
    for (const host of ["bedrock-runtime.us-east-1.amazonaws.com", "abc123.lambda-url.us-east-1.on.aws", "x.on.aws", "s3.amazonaws.com", "amazonaws.com", "api.rovara.example.com"]) {
      expect(planConnection(host, ["8.8.8.8"], { denySuffixes: ["rovara.example.com"] }), host).toEqual({ ok: false, refusal: "ssrf" });
    }
    expect(planConnection("notamazonaws.com", ["8.8.8.8"]).ok).toBe(true);
    expect([...MODEL_EGRESS_DENIED_SUFFIXES]).toContain("on.aws");
    // The same host passes with one answer and fails with the next: nothing is remembered between calls.
    expect(planConnection("api.openai.com", ["8.8.8.8"]).ok).toBe(true);
    expect(planConnection("api.openai.com", ["10.0.0.1"]).ok).toBe(false);
    expect(planConnection("api.openai.com", ["8.8.8.8"]).ok).toBe(true);
  });
  it("is https only, certificate verified, and never follows a redirect", () => {
    expect(planConnection("api.openai.com", ["8.8.8.8"])).toMatchObject({ scheme: "https", port: 443, verifyCertificate: true, followRedirects: false });
  });
  it("resolves the fully qualified name, so a search domain cannot be appended", () => {
    expect(lookupNameFor("api.openai.com")).toBe("api.openai.com.");
    for (const host of ["127.0.0.1", "localhost", "API.openai.com", "api.openai.com.", "", "a b"]) expect(lookupNameFor(host), host).toBeUndefined();
  });
});
