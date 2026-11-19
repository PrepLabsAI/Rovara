// L4-SQS: a role's SQS grants as a fence in front of an SQS double. Each command is checked against what the role may do on the queue it names (by queue name), as SQS and IAM would answer it:
// no matching grant is an AccessDenied (implicit deny), and the calls that were allowed and refused are kept so a test can say what a role reached. The grants are the infrastructure's own
// constants (infra/lib/core-engine.ts), which tests/contract/core-lessons-reflect-queue.test.ts and core-engine-infrastructure.test.ts hold equal to the synthesised policies.
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSServiceException, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SqsCommand, SqsSender } from "../../../packages/aws-adapters/src/index.js";

const ACTION_OF = new Map<unknown, string>([
  [SendMessageCommand, "sqs:SendMessage"], [ReceiveMessageCommand, "sqs:ReceiveMessage"], [DeleteMessageCommand, "sqs:DeleteMessage"],
  [ChangeMessageVisibilityCommand, "sqs:ChangeMessageVisibility"], [GetQueueAttributesCommand, "sqs:GetQueueAttributes"],
]);

/** Queue name (the last segment of the URL) to the actions the role is granted on it. */
export type QueueGrants = Readonly<Record<string, readonly string[]>>;

export interface FencedCall { action: string; queue: string }

export class SqsIamFence {
  readonly allowed: FencedCall[] = [];
  readonly denied: FencedCall[] = [];

  /** `inner` answers an allowed call; without one an allowed call answers `{}` (the call's own effect is not the test's point). */
  constructor(readonly grants: QueueGrants, private readonly inner?: SqsSender) {}

  readonly sender: SqsSender = {
    send: async (command: SqsCommand): Promise<unknown> => {
      const action = ACTION_OF.get((command as { constructor: unknown }).constructor);
      if (action === undefined) throw new Error("the fence knows only the five SQS commands the adapter sends");
      const url = (command.input as { QueueUrl?: string }).QueueUrl ?? "";
      const queue = url.slice(url.lastIndexOf("/") + 1);
      if (!(this.grants[queue] ?? []).includes(action)) {
        this.denied.push({ action, queue });
        throw new SQSServiceException({ name: "AccessDeniedException", $fault: "client", $metadata: {}, message: `not authorized to perform ${action} on ${queue}` });
      }
      this.allowed.push({ action, queue });
      return this.inner === undefined ? {} : this.inner.send(command);
    },
  };
}
