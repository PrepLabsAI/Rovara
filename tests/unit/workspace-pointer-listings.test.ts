import { expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { outboxCompaniesOf } from "../../packages/broker/src/aws/core-outbox-stream.js";
import { indexActivity } from "../../packages/broker/src/aws/activity-index.js";
import { readStream } from "../../packages/broker/src/developer/notifications.js";
import { marshall } from "@aws-sdk/util-dynamodb";

const companyId = IMPLICIT_COMPANY_ID;
const pointer = { pk: "WORKSPACE#pointer-canary", sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: "pointer-canary", companyId };
it("State change feeds never relay or index a discovery pointer", async () => {
  const record = { eventSource: "aws:dynamodb", eventName: "INSERT", dynamodb: { SequenceNumber: "1", NewImage: marshall(pointer) } };
  expect(outboxCompaniesOf({ Records: [record] })).toEqual([]);
  expect(readStream([record])).toEqual({ notices: [], skipped: [] });
  const store = { get: vi.fn(), put: vi.fn() };
  expect(await indexActivity([record], store, vi.fn())).toEqual({ failures: 0, usage: 0, failed: 0 });
  expect(store.get).not.toHaveBeenCalled();
  expect(store.put).not.toHaveBeenCalled();
});
