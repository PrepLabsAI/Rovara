import { describe, expect, it } from "vitest";
import { SUPPORTED_REGIONS, defaultProductionAvailabilityZoneIds } from "../../infra/lib/production-foundation.js";

describe("supported regions", () => {
  it("are exactly the regions with verified AgentCore availability-zone IDs", () => {
    expect(SUPPORTED_REGIONS).toEqual(["us-east-1"]);
    for (const region of SUPPORTED_REGIONS) expect(defaultProductionAvailabilityZoneIds(region)).toHaveLength(2);
  });
});
