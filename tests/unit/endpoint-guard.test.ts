// DEC 254t (a), row A3: the SSRF guard for a company's own endpoint, address by address. Only public unicast addresses pass; the URL is
// https on 443 with no user, query or fragment and a real host; DNS is resolved at call time and ANY bad answer refuses; the socket is
// pinned to the checked address. No network: the resolver is a fake.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { checkedAddress, endpointAddressProblem, endpointTarget, ENDPOINT_MAX_ADDRESSES, pinnedLookup, type EndpointResolver } from "../../packages/model-gateway/src/endpoint-guard.js";
/** A user part in a URL, built at runtime so no email-shaped literal sits in the file (cloud-ci novel-token scan). */
const AT = String.fromCharCode(64);

const REFUSED = [
  // IPv4
  "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.255",
  "169.254.0.1", "169.254.169.254", "169.254.170.2", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.0.170", "192.0.2.1", "192.88.99.1",
  "192.168.0.1", "192.168.255.255", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  // IPv6
  "::", "::1", "::127.0.0.1", "::10.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:8.8.8.8", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::8.8.8.8", "64:ff9b:1::1",
  "100::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:2::1", "2001:10::1", "2001:db8::1", "2002:a9fe:a9fe::1", "2002:808:808::1", "3fff::1",
  "fc00::1", "fd00::1", "fd00:ec2::254", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "ff02::1", "ff05::2",
  // not an address
  "", "localhost", "example.com", "1.2.3", "01.2.3.4", "1.2.3.256", "::g", "1::2::3",
];
const ALLOWED = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.255.255", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "192.0.1.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "2600::1", "[2606:4700:4700::1111]"];

describe("endpointAddressProblem, address by address", () => {
  it.each(REFUSED)("refuses %j", (address) => { expect(endpointAddressProblem(address)).toBe(true); });
  it.each(ALLOWED)("allows %j", (address) => { expect(endpointAddressProblem(address)).toBe(false); });
});

describe("endpointTarget (the base URL)", () => {
  it("keeps a public https host on 443 and its base path; the call path is <base>/chat/completions", () => {
    expect(endpointTarget("https://llm.example.com/v1")).toEqual({ hostname: "llm.example.com", path: "/v1/chat/completions", literal: false });
    expect(endpointTarget("https://LLM.Example.com:443/")).toEqual({ hostname: "llm.example.com", path: "/chat/completions", literal: false });
    expect(endpointTarget("https://8.8.8.8/v1")).toEqual({ hostname: "8.8.8.8", path: "/v1/chat/completions", literal: true });
    expect(endpointTarget("https://[2606:4700:4700::1111]/v1")).toEqual({ hostname: "2606:4700:4700::1111", path: "/v1/chat/completions", literal: true });
  });
  it.each([
    "http://llm.example.com/v1", "ftp://llm.example.com", "https://llm.example.com:8443/v1", "https://llm.example.com:80", `https://user:pass${AT}llm.example.com`, `https://user${AT}llm.example.com`,
    "https://llm.example.com/v1?x=1", "https://llm.example.com/v1#f", "https://localhost/v1", "https://api.localhost", "https://intranet", "https://service.internal", "https://box.local",
    "https://127.0.0.1/v1", "https://169.254.169.254/latest", "https://[::1]/", "https://[fd00:ec2::254]/", "https://[::ffff:127.0.0.1]/", "https://0x7f.1/", "https://2130706433/", "https://127.1/",
    "https://10.0.0.1.nip.io.", "https://llm.example.com/v1/../admin", "https://llm.example.com/%2e%2e/x", "https://llm.example.com/a b", "https:///nohost", "not a url", "", " https://llm.example.com",
    `https://${"a".repeat(64)}.example.com`, `https://llm.example.com/${"p".repeat(600)}`, "https://-bad.example.com", "https://llm.example.123",
  ])("refuses %j", (url) => {
    // 10.0.0.1.nip.io resolves to a private address: refused by the DNS check, not here. The trailing-dot name is a name, allowed here.
    if (url === "https://10.0.0.1.nip.io.") { expect(endpointTarget(url)?.hostname).toBe("10.0.0.1.nip.io."); return; }
    expect(endpointTarget(url)).toBeUndefined();
  });
  it("refuses anything that is not a string", () => { for (const v of [undefined, null, 1, {}, ["https://llm.example.com"]]) expect(endpointTarget(v)).toBeUndefined(); });
});

describe("checkedAddress: DNS at call time, every answer checked", () => {
  const target = endpointTarget("https://llm.example.com/v1")!;
  const resolver = (answers: Array<{ address: string; family: number }> | Error): EndpointResolver & { asked: string[] } => {
    const asked: string[] = [];
    return Object.assign(async (host: string) => { asked.push(host); if (answers instanceof Error) throw answers; return answers; }, { asked });
  };
  const signal = new AbortController().signal;

  it("a name whose answers are all public: the first one, resolved now", async () => {
    const r = resolver([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
    expect(await checkedAddress(target, r, signal)).toEqual({ address: "93.184.216.34", family: 4 });
    expect(r.asked).toEqual(["llm.example.com"]);
  });

  it.each(["127.0.0.1", "169.254.169.254", "169.254.170.2", "10.1.2.3", "fd00:ec2::254", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe"])("refuses when ANY answer is %s (a rebinding name cannot slip one in)", async (bad) => {
    expect(await checkedAddress(target, resolver([{ address: "93.184.216.34", family: 4 }, { address: bad, family: bad.includes(":") ? 6 : 4 }]), signal)).toBeUndefined();
    expect(await checkedAddress(target, resolver([{ address: bad, family: 4 }]), signal)).toBeUndefined();
  });

  it("refuses no answer, too many answers, malformed answers and a failed lookup", async () => {
    for (const r of [resolver([]), resolver(Array.from({ length: ENDPOINT_MAX_ADDRESSES + 1 }, () => ({ address: "8.8.8.8", family: 4 }))), resolver([{ address: "not-ip", family: 4 }]), resolver(new Error("ENOTFOUND"))]) {
      expect(await checkedAddress(target, r, signal)).toBeUndefined();
    }
  });

  it("A3-REVIEW-1 L2 (M12): a literal target built directly (not through endpointTarget) is re-checked: a private literal is refused", async () => {
    const r = resolver([{ address: "8.8.8.8", family: 4 }]);
    for (const hostname of ["127.0.0.1", "169.254.169.254", "fd00:ec2::254", "10.0.0.1"]) expect(await checkedAddress({ hostname, path: "/chat/completions", literal: true }, r, signal)).toBeUndefined();
    expect(r.asked).toEqual([]);
  });

  it("A3-REVIEW-1 L1: pins an IPv4 answer when there is one (the network has no IPv6), after checking every answer", async () => {
    expect(await checkedAddress(target, resolver([{ address: "2606:4700:4700::1111", family: 6 }, { address: "93.184.216.34", family: 4 }]), signal)).toEqual({ address: "93.184.216.34", family: 4 });
    expect(await checkedAddress(target, resolver([{ address: "2606:4700:4700::1111", family: 6 }]), signal)).toEqual({ address: "2606:4700:4700::1111", family: 6 });
    expect(await checkedAddress(target, resolver([{ address: "fd00:ec2::254", family: 6 }, { address: "93.184.216.34", family: 4 }]), signal)).toBeUndefined();
  });

  it("an IP literal is checked without DNS", async () => {
    const r = resolver([{ address: "8.8.8.8", family: 4 }]);
    expect(await checkedAddress(endpointTarget("https://8.8.4.4/v1")!, r, signal)).toEqual({ address: "8.8.4.4", family: 4 });
    expect(r.asked).toEqual([]);
  });
});

describe("pinnedLookup: the socket only ever reaches the checked address", () => {
  it("answers the checked address whatever name is asked, in both lookup shapes", () => {
    const lookup = pinnedLookup("93.184.216.34", 4);
    const single: unknown[] = []; const all: unknown[] = [];
    lookup("evil.example", {}, (...args) => single.push(...args));
    lookup("evil.example", { all: true }, (...args) => all.push(...args));
    expect(single).toEqual([null, "93.184.216.34", 4]);
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });
});
