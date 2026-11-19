// L4-EGR: the pure parts of Rovara's outbound addresses (contracts company-egress-addresses.ts): the broker's reader of its variable, the non-public ranges, the strict view, and the
// stack parameter's pattern agreeing with the reader (a value the template accepts is a value the broker reads whole).
import { describe, expect, it } from "vitest";
import {
  CompanyEgressAddressesViewSchema, EGRESS_ADDRESSES_MAX, EGRESS_ADDRESSES_PARAMETER_PATTERN, EGRESS_ADDRESS_NOTICE_DAYS, isNonPublicIpv4, parseEgressAddresses,
} from "@agentx/contracts";

describe("parseEgressAddresses", () => {
  it("reads absent and empty as no addresses, and a list as the list, in order", () => {
    expect(parseEgressAddresses(undefined)).toEqual([]);
    expect(parseEgressAddresses("")).toEqual([]);
    expect(parseEgressAddresses("203.0.113.195")).toEqual(["203.0.113.195"]);
    expect(parseEgressAddresses("198.51.100.187,203.0.113.195")).toEqual(["198.51.100.187", "203.0.113.195"]);
    expect(parseEgressAddresses("1.2.3.4,5.6.7.8,9.10.11.12,13.14.15.16")).toHaveLength(EGRESS_ADDRESSES_MAX);
  });

  it("refuses the WHOLE value for anything off, never a part", () => {
    const bad = ["x", " ", "203.0.113.195,", ",203.0.113.195", "203.0.113.195,,198.51.100.187", "203.0.113.195, 198.51.100.187", " 203.0.113.195", "203.0.113.256", "203.0.113", "203.0.113.1.5", "0203.0.113.195",
      "203.0.113.195,203.0.113.195", "1.2.3.4,5.6.7.8,9.10.11.12,13.14.15.16,17.18.19.20", "203.0.113.195\n", "2001:db8::1", "203.0.113.195/32", "0x2c.0xeb.0x88.0xc3", "203.0.113.195;198.51.100.187"];
    for (const value of bad) expect(parseEgressAddresses(value), JSON.stringify(value)).toBeUndefined();
  });

  it("refuses addresses that are never public: private, loopback, link-local, carrier-grade NAT, this-network, multicast and reserved", () => {
    for (const value of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "203.0.113.195,10.0.0.1"]) {
      expect(parseEgressAddresses(value), value).toBeUndefined();
    }
    for (const value of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "169.253.0.1", "192.167.0.1", "223.255.255.255", "11.0.0.1"]) expect(isNonPublicIpv4(value), value).toBe(false);
  });
});

describe("the stack parameter's pattern and the reader agree", () => {
  const pattern = new RegExp(EGRESS_ADDRESSES_PARAMETER_PATTERN, "u");
  it("every value the pattern accepts, the reader reads whole, unless it is a non-public or repeated address", () => {
    for (const value of ["", "203.0.113.195", "203.0.113.195,198.51.100.187", "1.2.3.4,5.6.7.8,9.10.11.12,13.14.15.16"]) {
      expect(pattern.test(value), value).toBe(true);
      expect(parseEgressAddresses(value)).toEqual(value === "" ? [] : value.split(","));
    }
    // The pattern checks the shape only: a private or repeated address passes it and the broker still refuses the whole value.
    expect(pattern.test("10.0.0.1")).toBe(true);
    expect(parseEgressAddresses("10.0.0.1")).toBeUndefined();
  });
  it("what the reader refuses for shape, the pattern refuses too", () => {
    for (const value of [" ", "203.0.113.195,", "0203.0.113.195", "203.0.113.256", "1.2.3.4,5.6.7.8,9.10.11.12,13.14.15.16,17.18.19.20", "203.0.113.195\n", "2001:db8::1"]) expect(pattern.test(value), JSON.stringify(value)).toBe(false);
  });
});

describe("CompanyEgressAddressesViewSchema", () => {
  it("is strict: addresses only, public, unique, at most the maximum", () => {
    expect(CompanyEgressAddressesViewSchema.safeParse({ addresses: [] }).success).toBe(true);
    expect(CompanyEgressAddressesViewSchema.safeParse({ addresses: ["203.0.113.195", "198.51.100.187"] }).success).toBe(true);
    for (const bad of [{}, { addresses: ["10.0.0.1"] }, { addresses: ["x"] }, { addresses: ["203.0.113.195", "203.0.113.195"] }, { addresses: ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"] }, { addresses: [], companyId: "x" }, { addresses: "203.0.113.195" }]) {
      expect(CompanyEgressAddressesViewSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("the notice promise is 30 days", () => { expect(EGRESS_ADDRESS_NOTICE_DAYS).toBe(30); });
});
