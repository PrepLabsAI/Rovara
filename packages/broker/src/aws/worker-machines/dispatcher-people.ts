// Lead 4 L4-HW8: the people port of the dispatcher's lessons reader (`dispatcher-lessons.ts`), for ONE company, read-only. The dispatcher decides nothing for a person, but loading lessons into a worker step must
// still ask who is on the project's roster now (a task's source lessons are shown only to the project's audience, `lessons/hosted-people.ts`), so the port the broker's lessons already use
// (`createHostedLessonsPeople`, aws/hosted-lessons-people.ts: live membership, company-bound, throws for another company) is reused here over a client that can only do what the dispatcher's role may:
//   - sign-in table: one strongly consistent GetItem, and ONLY of `COMPANY_MEMBER#<id>` with the Membership fields or `DEVELOPER#<id>` with the projected developer fields: the exact keys and attributes the dispatcher role is granted
//     (infra/lib/task-person-proof.ts `DispatcherPolicy`); any other key, any other command, any other table is refused before it is sent;
//   - State table: GetItem only (the project grant row `MEMBER#<id>` / `PROJECT#<name>`); no Query, no write.
// NOT given (no new IAM): the company's member list (a Query the dispatcher's role is not granted) so `approvers` and `projectMembers` refuse; and the merge record `mergedInto` of a developer (not among the attributes the role may read)
// so `resolveMember` is absent and ids compare as they are, exactly as the dispatcher's lessons did before this port (the approvals were checked with merges resolved when they were made, on the broker).
// Nothing here writes, keeps anything between calls, or takes a company from the job: the company is the one the runtime was built for.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { HostedLessonPeople } from "../../lessons/hosted-people.js";
import { createHostedLessonsPeople } from "../hosted-lessons-people.js";
import { TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES, TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES } from "../task-person-runtime.js";
import { NO_PEOPLE_HERE } from "./dispatcher-core.js";

type Sender = { send(command: unknown): Promise<unknown> };

export interface DispatcherLessonsPeopleBase {
  /** The dispatcher's document client. */
  documentClient: Sender;
  stateTableName: string;
  /** `DEVELOPER_SIGNIN_TABLE_NAME`: undefined or empty means no company layer, and every question throws (so no source lesson is shown). */
  signInTableName: string | undefined;
  now: () => number;
}

const refused = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", NO_PEOPLE_HERE); };
const attributeNames = (attributes: readonly string[]) => ({
  ProjectionExpression: attributes.map((_, index) => `#p${index}`).join(", "),
  ExpressionAttributeNames: Object.fromEntries(attributes.map((attribute, index) => [`#p${index}`, attribute])),
});

/** The dispatcher's document client as the lessons' people port may use it: GetItem of exactly what the role grants, each with its projection; everything else throws. */
export function dispatcherPeopleClient(base: Pick<DispatcherLessonsPeopleBase, "documentClient" | "stateTableName" | "signInTableName">): Sender {
  return {
    async send(command: unknown): Promise<unknown> {
      if (!(command instanceof GetCommand)) return refused();
      const input = command.input;
      const key = input.Key as { pk?: unknown; sk?: unknown } | undefined;
      if (input.ConsistentRead !== true || typeof key?.pk !== "string" || typeof key.sk !== "string") return refused();
      if (input.TableName === base.stateTableName) {
        // The project grant row only: this person's grant on one project.
        if (!key.pk.startsWith("MEMBER#") || !key.sk.startsWith("PROJECT#")) return refused();
        return await base.documentClient.send(command);
      }
      if (base.signInTableName === undefined || base.signInTableName === "" || input.TableName !== base.signInTableName) return refused();
      if (key.pk.startsWith("COMPANY_MEMBER#") && key.sk === "COMPANY") {
        return await base.documentClient.send(new GetCommand({ TableName: input.TableName, Key: key, ConsistentRead: true, ...attributeNames(TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES) }));
      }
      if (key.pk.startsWith("DEVELOPER#") && key.sk === "META") {
        return await base.documentClient.send(new GetCommand({ TableName: input.TableName, Key: key, ConsistentRead: true, ...attributeNames(TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES) }));
      }
      return refused();
    },
  };
}

/** The port factory for the dispatcher: `(companyId, context) => HostedLessonPeople`, one company at a time. Building a port reads nothing. */
export function createDispatcherLessonsPeople(base: DispatcherLessonsPeopleBase): (companyId: OrgId, context: { store: () => Promise<Pick<DocumentStore, "get">> }) => HostedLessonPeople {
  const full = createHostedLessonsPeople({ documentClient: dispatcherPeopleClient(base), stateTableName: base.stateTableName, signInTableName: base.signInTableName, now: base.now });
  return (companyId, context) => {
    const port = full(companyId, context);
    return {
      // Not readable here (no Query on the sign-in table): refused in fixed words, no read is tried.
      approvers: async () => refused(),
      onProjectRoster: (company, project, personId) => port.onProjectRoster(company, project, personId),
      linkedAccounts: (company, personId) => port.linkedAccounts(company, personId),
      displayName: (company, personId) => port.displayName(company, personId),
      isErased: (company, personId) => port.isErased(company, personId),
      // `projectMembers` and `resolveMember` are left out on purpose (see the top of this file).
    };
  };
}
