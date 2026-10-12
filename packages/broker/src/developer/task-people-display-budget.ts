import {
  TaskPeopleDisplayReadResponseSchema,
  agentXError,
  type TaskChannelPeopleRequest,
  type TaskChannelPeopleResponse,
  type TaskPeopleDisplayReadRequest,
  type TaskPeopleDisplayReadResponse,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
} from "@agentx/contracts";
import { developerIdForSlackUser } from "../aws/admin-actions.js";

const MAX_MILLISECONDS = 20_000;
const MAX_SLACK_CALLS = 100;
const MAX_IDENTITIES = 100;
const HEX64 = /^[a-f0-9]{64}$/;
type WithoutAdmission<T> = T extends unknown ? Omit<T, "admission"> : never;
type DisplayReadWithoutAdmission = WithoutAdmission<TaskPeopleDisplayReadRequest>;

const unavailable = (): never => { throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable"); };

export interface TaskPeopleDisplayAdmission {
  assertOpen(): void;
  admitIdentity(developerId: string): void;
  noteNativeIdentity(developerId: string, slackUserId: string): void;
  proof(request: TaskPersonProofRequest): Promise<TaskPersonProofResponse>;
  directory(request: TaskChannelPeopleRequest): Promise<TaskChannelPeopleResponse>;
  close(): void;
}

export function taskPeopleDisplayAdmission(input: {
  now(): number;
  read(request: TaskPeopleDisplayReadRequest): Promise<TaskPeopleDisplayReadResponse>;
}): TaskPeopleDisplayAdmission {
  const deadlineAt = input.now() + MAX_MILLISECONDS;
  const identities = new Set<string>();
  const nativeSlackUserIds = new Set<string>();
  let slackCallsLeft = MAX_SLACK_CALLS;
  let sealed = false;
  let inFlight = false;

  const seal = (): never => {
    sealed = true;
    return unavailable();
  };
  const assertOpen = () => {
    if (sealed || input.now() >= deadlineAt) return seal();
  };
  const admitIdentity = (developerId: string) => {
    assertOpen();
    if (!HEX64.test(developerId)) return seal();
    identities.add(developerId);
    if (identities.size > MAX_IDENTITIES) return seal();
  };
  const noteNativeIdentity = (developerId: string, slackUserId: string) => {
    admitIdentity(developerId);
    if (developerIdForSlackUser(slackUserId) === developerId) nativeSlackUserIds.add(slackUserId);
  };

  const read = async (request: DisplayReadWithoutAdmission) => {
    assertOpen();
    if (inFlight || slackCallsLeft <= 0) return seal();
    inFlight = true;
    const reserved = slackCallsLeft;
    try {
      const response = await input.read({ ...request, admission: { version: 1, deadlineAt, slackCallsLimit: reserved } });
      const parsed = TaskPeopleDisplayReadResponseSchema.safeParse(response);
      if (!parsed.success || parsed.data.operation !== request.operation || parsed.data.admission.slackCallsUsed > reserved) return seal();
      slackCallsLeft -= parsed.data.admission.slackCallsUsed;
      assertOpen();
      return parsed.data;
    } catch {
      return seal();
    } finally {
      inFlight = false;
    }
  };

  return {
    assertOpen,
    admitIdentity,
    noteNativeIdentity,
    async proof(request) {
      const response = await read({ kind: "task-people-display-read", operation: "proof", request });
      return response.result as TaskPersonProofResponse;
    },
    async directory(request) {
      const response = await read({
        kind: "task-people-display-read", operation: "directory", request,
        remainingNewIdentities: MAX_IDENTITIES - identities.size,
        knownNativeSlackUserIds: [...nativeSlackUserIds].sort(),
      });
      const result = response.result as TaskChannelPeopleResponse;
      if (result.ok) {
        const prospective = new Set(identities);
        for (const user of result.users) prospective.add(developerIdForSlackUser(user.id));
        if (prospective.size > MAX_IDENTITIES) return seal();
        for (const user of result.users) {
          identities.add(developerIdForSlackUser(user.id));
          nativeSlackUserIds.add(user.id);
        }
      }
      return result;
    },
    close() { sealed = true; },
  };
}
