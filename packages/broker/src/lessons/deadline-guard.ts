// A reflection that is past its deadline writes nothing more to the lessons' store. A host that runs reflections as jobs gives its store client to the team record and the lessons through this wrapper:
// once the running attempt's abort signal (`learning-deadline.ts`) is aborted, a write command (put, update, delete, batch or transaction) to one of the guarded tables is refused before it is sent. A write
// already sent finishes on its own (a transaction is all or nothing), so ONE transaction is never left half-written. A lesson change that takes several writes can still stop between two of them: the guard refuses the
// later ones and the intent is left for the `LESSON_BUSY` retry and the hourly heal to finish (re-check). Other tables are not
// guarded: the spend ledger must still block and settle the attempt's model keys after the deadline. Outside an attempt (the broker, tests) nothing is refused.
import { currentLearningAttempt } from "./learning-deadline.js";

export const LEARNING_WRITE_DEADLINE = "the reflection ran out of time before this write";

const WRITE_COMMANDS = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "BatchWriteCommand", "TransactWriteCommand"]);

/** The tables a command writes to. */
function tablesOf(command: { constructor: { name: string }; input?: Record<string, unknown> }): string[] {
  if (!WRITE_COMMANDS.has(command.constructor.name)) return [];
  const input = command.input ?? {};
  const tables: string[] = [];
  if (typeof input["TableName"] === "string") tables.push(input["TableName"]);
  for (const item of Array.isArray(input["TransactItems"]) ? input["TransactItems"] as Array<Record<string, { TableName?: unknown } | undefined>> : []) {
    for (const part of [item["Put"], item["Update"], item["Delete"]]) if (typeof part?.TableName === "string") tables.push(part.TableName);
  }
  if (input["RequestItems"] !== null && typeof input["RequestItems"] === "object") tables.push(...Object.keys(input["RequestItems"]));
  return tables;
}

export function deadlineGuardedClient<T extends { send(command: never, ...rest: never[]): Promise<unknown> }>(client: T, guardedTable: (tableName: string) => boolean): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "send") return Reflect.get(target, property, receiver) as unknown;
      return (command: { constructor: { name: string }; input?: Record<string, unknown> }, ...rest: unknown[]) => {
        if (currentLearningAttempt()?.signal?.aborted === true && tablesOf(command).some(guardedTable)) return Promise.reject(new Error(LEARNING_WRITE_DEADLINE));
        return (target.send as (...args: unknown[]) => Promise<unknown>).call(target, command, ...rest);
      };
    },
  });
}
