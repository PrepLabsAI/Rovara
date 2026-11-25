// Reviewer tests (Opus review of the address stack lane, 2026-11-24): failure modes the lane's tests do not drive.
import { describe, expect, it } from "vitest";
import { CreateChangeSetCommand, DeleteChangeSetCommand, DescribeChangeSetCommand, DescribeStacksCommand, ExecuteChangeSetCommand, flipAddress, type FlipCloudFormation } from "../../scripts/address-flip.js";

const OLD = "abcde12345";
const NEW = "fghij67890";

function fake(changeSet: Record<string, unknown>, options: { deleteFails?: boolean } = {}) {
  const names: string[] = [];
  const client: FlipCloudFormation = {
    async send(command: unknown): Promise<unknown> {
      names.push((command as { constructor: { name: string } }).constructor.name);
      if (command instanceof DescribeStacksCommand) {
        return { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: [{ ParameterKey: "ApiId", ParameterValue: OLD }], Outputs: [{ OutputKey: "PublicApiOrigin", OutputValue: "https://api.example.com" }] }] };
      }
      if (command instanceof CreateChangeSetCommand) return { Id: "id" };
      if (command instanceof DescribeChangeSetCommand) return changeSet;
      if (command instanceof DeleteChangeSetCommand) { if (options.deleteFails === true) throw new Error("AccessDenied on DeleteChangeSet"); return {}; }
      if (command instanceof ExecuteChangeSetCommand) return {};
      throw new Error("unexpected");
    },
  };
  return { client, names };
}

describe("the flip's failure modes", () => {
  it("gives up on a change set stuck in CREATE_PENDING and never executes it, even with execute", async () => {
    const cf = fake({ Status: "CREATE_PENDING", Changes: [] });
    await expect(flipAddress({ cloudFormation: cf.client, sleep: async () => undefined, maxPolls: 3 }, { env: undefined, apiId: NEW, execute: true })).rejects.toThrow(/gave up waiting for change set/u);
    expect(cf.names).not.toContain("ExecuteChangeSetCommand");
    // Fixed (L2): the change set is deleted on this path, so it cannot later reach CREATE_COMPLETE unchecked.
    expect(cf.names).toContain("DeleteChangeSetCommand");
  });

  it("never executes a refused change set even when deleting it fails (both the refusal and the delete error are reported, L3)", async () => {
    const cf = fake({ Status: "CREATE_COMPLETE", Parameters: [{ ParameterKey: "ApiId", ParameterValue: NEW }], Changes: [] }, { deleteFails: true });
    await expect(flipAddress({ cloudFormation: cf.client, sleep: async () => undefined }, { env: undefined, apiId: NEW, execute: true })).rejects.toThrow(/0 changes[\s\S]*AccessDenied on DeleteChangeSet/u);
    expect(cf.names).not.toContain("ExecuteChangeSetCommand");
  });
});
