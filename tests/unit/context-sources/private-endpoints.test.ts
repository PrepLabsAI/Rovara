import { describe, expect, it, vi } from "vitest";
import { checkAllowedPrivateEndpoint, checkPrivateEndpointForProbe, isNeverCalledAddress, parseInstallCidrs, parsePrivateTarget, privateMcpEndpointGuard, probeMcpEndpointGuard } from "../../../packages/broker/src/connections/private-endpoints.js";

const resolves = (...addresses: string[]) => async () => addresses;
const INSTALL = ["10.0.0.0/8"];
const allowed = [{ host: "sim.corp.example", port: 443, cidrs: INSTALL }];

describe("addresses Rovara never calls", () => {
  it.each(["127.0.0.1", "127.8.8.8", "0.0.0.0", "169.254.169.254", "169.254.170.2", "::1", "::", "fe80::1", "fd00:ec2::254", "224.0.0.1", "255.255.255.255", "::ffff:169.254.169.254", "::ffff:127.0.0.1", "not-an-address", "64:ff9b::a9fe:a9fe", "::a9fe:a9fe", "2002:a9fe:a9fe::1", "100.100.100.200", "2001:0:4136:e378:8000:63bf:3fff:fdd2"])("%s", (address) => {
    expect(isNeverCalledAddress(address)).toBe(true);
  });
  it.each(["10.1.2.3", "172.16.5.5", "192.168.1.1", "100.64.1.1", "8.8.8.8", "fd12:3456::1"])("%s is an address a private server may have", (address) => {
    expect(isNeverCalledAddress(address)).toBe(false);
  });
});

describe("the pasted address", () => {
  it("accepts a host name with a port and any path", () => {
    expect(parsePrivateTarget("https://sim.corp.example:8443/mcp")).toMatchObject({ host: "sim.corp.example", port: 8443 });
    expect(parsePrivateTarget("https://Sim.Corp.Example/mcp")).toMatchObject({ host: "sim.corp.example", port: 443 });
    expect(parsePrivateTarget("https://intranet/mcp")).toMatchObject({ host: "intranet" });
  });
  it.each([
    ["http://sim.corp.example/mcp", /https/], ["https://u:p@sim.corp.example/", /user name/], ["https://sim.corp.example/mcp?x=1", /query/], ["https://sim.corp.example/#f", /query or fragment/],
    ["https://10.0.0.5/mcp", /host name/], ["https://[::1]/mcp", /host name/], ["not a url", /web address/], ["https://sim.corp.example:99999/", /web address|port/],
  ])("refuses %s", (value, reason) => {
    const result = parsePrivateTarget(value);
    expect("problem" in result && reason.test(result.problem)).toBe(true);
  });
});

describe("a call goes only where the allow-list says", () => {
  it("passes an approved host and port whose addresses are private", async () => {
    const checked = await checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", allowed, resolves("10.1.2.3", "10.1.2.4"));
    expect(checked.addresses).toEqual(["10.1.2.3", "10.1.2.4"]);
  });
  it("refuses a host or port that is not on the list, and an empty list", async () => {
    await expect(checkAllowedPrivateEndpoint("https://other.corp.example/mcp", allowed, resolves("10.1.2.3"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example:8443/mcp", allowed, resolves("10.1.2.3"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", [], resolves("10.1.2.3"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("refuses an approved host that now resolves to the metadata service, loopback, or any one bad address among good ones", async () => {
    for (const bad of ["169.254.169.254", "127.0.0.1", "::1", "fd00:ec2::254"]) {
      await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", allowed, resolves("10.1.2.3", bad))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });
  it("fails closed when the name does not resolve or the lookup fails", async () => {
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", allowed, resolves())).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", allowed, async () => { throw new Error("SERVFAIL"); })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
  it("holds an entry to its ranges, and refuses an entry with none (the install's ranges are what bound a call)", async () => {
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", [{ host: "sim.corp.example", port: 443 }], resolves("10.1.2.3"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", allowed, resolves("203.0.113.5"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("holds an entry to its ranges when it names some, and refuses a range that does not parse", async () => {
    const ranged = [{ host: "sim.corp.example", port: 443, cidrs: ["10.2.0.0/16"] }];
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", ranged, resolves("10.2.9.9"))).resolves.toBeDefined();
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", ranged, resolves("10.3.0.1"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", [{ host: "sim.corp.example", port: 443, cidrs: ["garbage"] }], resolves("10.2.9.9"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("the guard reads the list on every call, so an entry removed a moment ago is refused", async () => {
    let list = [...allowed];
    const guard = privateMcpEndpointGuard({ allowed: async () => list, resolveHost: resolves("10.1.2.3") });
    expect(typeof await guard(new URL("https://sim.corp.example/mcp"))).toBe("function");
    list = [];
    await expect(guard(new URL("https://sim.corp.example/mcp"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("the fetch the guard gives is held to the checked endpoint", async () => {
    const request = vi.fn();
    const guard = privateMcpEndpointGuard({ allowed: async () => allowed, resolveHost: resolves("10.1.2.3"), request });
    const fetchChecked = await guard(new URL("https://sim.corp.example/mcp"));
    await expect(fetchChecked("https://elsewhere.corp.example/mcp")).rejects.toThrow(/checked endpoint/u);
    await expect(fetchChecked("https://10.9.9.9/mcp")).rejects.toThrow(/checked endpoint/u);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("testing a pasted address before it is approved", () => {
  it("needs no allow-list, but still never calls the never-called addresses", async () => {
    await expect(checkPrivateEndpointForProbe("https://sim.corp.example/mcp", INSTALL, resolves("10.1.2.3"))).resolves.toMatchObject({ addresses: ["10.1.2.3"] });
    await expect(checkPrivateEndpointForProbe("https://sim.corp.example/mcp", INSTALL, resolves("169.254.169.254"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(checkPrivateEndpointForProbe("http://sim.corp.example/mcp", INSTALL, resolves("10.1.2.3"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the install's address ranges bound a test and a call", () => {
  it("refuses a test of a host that resolves outside them (a public host, or another private range), and every test when none are set", async () => {
    await expect(checkPrivateEndpointForProbe("https://collector.attacker.example/mcp", INSTALL, resolves("203.0.113.5"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkPrivateEndpointForProbe("https://sim.corp.example/mcp", ["172.16.0.0/12"], resolves("10.1.2.3"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkPrivateEndpointForProbe("https://sim.corp.example/mcp", [], resolves("10.1.2.3"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("reads the ranges from the operator's setting, and accepts private ranges only", () => {
    expect(parseInstallCidrs(" 10.0.0.0/8, 172.20.0.0/16 ,fd12::/16")).toEqual(["10.0.0.0/8", "172.20.0.0/16", "fd12::/16"]);
    expect(parseInstallCidrs(undefined)).toEqual([]);
    expect(parseInstallCidrs("")).toEqual([]);
    for (const bad of ["0.0.0.0/0", "8.8.8.0/24", "10.0.0.0/7", "10.0.0.0", "garbage", "10.0.0.0/8,203.0.113.0/24", "169.254.0.0/16", "127.0.0.0/8"]) expect(() => parseInstallCidrs(bad), bad).toThrow();
  });
});

describe("the install's own network is never a private MCP server", () => {
  const VPC = ["10.42.0.0/16"];
  it("refuses an install range that overlaps the install network (contains it, sits inside it, or is the same), and accepts a disjoint one", () => {
    for (const cidr of ["10.0.0.0/8", "10.42.0.0/16", "10.42.5.0/24", "10.40.0.0/14"]) expect(() => parseInstallCidrs(cidr, VPC), cidr).toThrow(/ROVARA_PRIVATE_MCP_CIDRS.*Rovara/u);
    expect(parseInstallCidrs("10.43.0.0/16, 192.168.4.0/24", VPC)).toEqual(["10.43.0.0/16", "192.168.4.0/24"]);
    // without the install network given, as before
    expect(parseInstallCidrs("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
  });
  it("refuses a test of a host that resolves inside the install network before any connection, with the one fixed answer, whatever the ranges say", async () => {
    const request = vi.fn();
    for (const address of ["10.42.7.9", "::ffff:10.42.7.9"]) {
      await expect(checkPrivateEndpointForProbe("https://sim.corp.example/mcp", ["10.0.0.0/8"], resolves(address), VPC), address).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(checkPrivateEndpointForProbe("https://sim.corp.example/mcp", ["10.0.0.0/8"], resolves(address), VPC), address).rejects.toThrow(/never calls/u);
    }
    // the answer is the same as for a metadata address, so an open port in the install network cannot be told from a closed one
    const metadata = await checkPrivateEndpointForProbe("https://sim.corp.example/mcp", ["10.0.0.0/8"], resolves("169.254.169.254"), VPC).catch((error: Error) => error.message);
    const inside = await checkPrivateEndpointForProbe("https://sim.corp.example/mcp", ["10.0.0.0/8"], resolves("10.42.7.9"), VPC).catch((error: Error) => error.message);
    expect(inside).toBe(metadata);
    const guard = probeMcpEndpointGuard({ installCidrs: ["10.0.0.0/8"], resolveHost: resolves("10.42.7.9"), rovaraCidrs: VPC, request });
    await expect(guard(new URL("https://sim.corp.example/mcp"))).rejects.toThrow(/never calls/u);
    expect(request).not.toHaveBeenCalled();
    // outside the install network the same test passes
    await expect(checkPrivateEndpointForProbe("https://sim.corp.example/mcp", ["10.0.0.0/8"], resolves("10.43.7.9"), VPC)).resolves.toMatchObject({ addresses: ["10.43.7.9"] });
  });
  it("refuses a call to an approved server that now resolves inside the install network", async () => {
    const allowed = [{ host: "sim.corp.example", port: 443, cidrs: ["10.0.0.0/8"] }];
    await expect(checkAllowedPrivateEndpoint("https://sim.corp.example/mcp", allowed, resolves("10.42.1.1"), VPC)).rejects.toThrow(/never calls/u);
    const request = vi.fn();
    await expect(privateMcpEndpointGuard({ allowed: async () => allowed, resolveHost: resolves("10.42.1.1"), rovaraCidrs: VPC, request })(new URL("https://sim.corp.example/mcp"))).rejects.toThrow(/never calls/u);
    expect(request).not.toHaveBeenCalled();
  });
});
