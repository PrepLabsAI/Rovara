// L4-E7: where the stand-in writer's request comes from. The writer is given SHAPES: the tables the schema reading (lane E3, the generated test data) found and the answer shapes of the outside services the contract finder
// (lane E6, the HTTP stand-ins) found. Both readers are named seams here (`StandInShapeReader`): they read the checked-out repositories at the commit the broker resolved, and answer names, kinds and shapes only. Nothing in
// their answer can be a row: `StandInTableSeam` has no value field, so a reader that copied a real row would not type-check, and `buildStandInRequest` drops anything else.
import { buildStandInRequest, type StandInOperationSeam, type StandInTableSeam, type StandInWriterInput } from "@agentx/contracts";
import type { TrackedPaths } from "./setup-citations.js";
import type { SetupAgentRepository } from "./setup-agent.js";

export interface StandInShapes { tables: readonly StandInTableSeam[]; operations: readonly StandInOperationSeam[] }
/** One reader of the repositories' shapes. Throwing is the same as finding nothing. */
export type StandInShapeReader = (repositories: ReadonlyArray<SetupAgentRepository>, tracked: TrackedPaths) => Promise<StandInShapes>;

/**
 * The readers the worker uses. Until lanes E3 (tables) and E6 (outside answers) are merged they read nothing, so a setup run's writer step says it found nothing to write; it never guesses a table. Each lane replaces its own
 * line here with its reader.
 */
export const STANDIN_SHAPE_READERS: { tables: (...args: Parameters<StandInShapeReader>) => Promise<readonly StandInTableSeam[]>; operations: (...args: Parameters<StandInShapeReader>) => Promise<readonly StandInOperationSeam[]> } = {
  tables: () => Promise.resolve([]),
  operations: () => Promise.resolve([]),
};

/** The writer's request for these repositories: shapes only, bounded, or undefined when there is nothing to write. */
export async function standInRequestOf(repositories: ReadonlyArray<SetupAgentRepository>, tracked: TrackedPaths, readers: typeof STANDIN_SHAPE_READERS = STANDIN_SHAPE_READERS): Promise<StandInWriterInput | undefined> {
  const [tables, operations] = await Promise.all([
    readers.tables(repositories, tracked).catch(() => [] as readonly StandInTableSeam[]),
    readers.operations(repositories, tracked).catch(() => [] as readonly StandInOperationSeam[]),
  ]);
  return buildStandInRequest(tables, operations)?.input;
}
