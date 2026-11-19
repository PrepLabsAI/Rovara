// L4-E7: where the stand-in writer's request comes from. The writer is given SHAPES: the tables the schema reading (lane E3, the generated test data) found and the answer shapes of the outside services the contract finder
// (lane E6, the HTTP stand-ins) found. Both readers are named seams here (`StandInShapeReader`): they read the checked-out repositories at the commit the broker resolved, and answer names, kinds and shapes only. Nothing in
// their answer can be a row: `StandInTableSeam` has no value field, so a reader that copied a real row would not type-check, and `buildStandInRequest` drops anything else.
import { buildStandInRequest, type StandInOperationSeam, type StandInTableSeam, type StandInWriterInput } from "@agentx/contracts";
import type { TrackedPaths } from "./setup-citations.js";
import type { SetupAgentRepository } from "./setup-agent.js";
import { readOperationSeams, readTableSeams } from "./standin-readers.js";

export interface StandInShapes { tables: readonly StandInTableSeam[]; operations: readonly StandInOperationSeam[] }
/** One reader of the repositories' shapes. Throwing is the same as finding nothing. */
export type StandInShapeReader = (repositories: ReadonlyArray<SetupAgentRepository>, tracked: TrackedPaths) => Promise<StandInShapes>;

/**
 * The readers the worker uses (L4-EINT: E3's tables from the repository's SQL, E6's operations from its OpenAPI descriptions). A repository with neither gives nothing, so the writer step says it found nothing to write; it never guesses a table.
 */
export const STANDIN_SHAPE_READERS: { tables: (...args: Parameters<StandInShapeReader>) => Promise<readonly StandInTableSeam[]>; operations: (...args: Parameters<StandInShapeReader>) => Promise<readonly StandInOperationSeam[]> } = {
  // L4-EINT: the repository's own SQL (tables) and OpenAPI descriptions (outside operations), tracked files only, names and shapes only.
  tables: readTableSeams,
  operations: readOperationSeams,
};

/** The writer's request for these repositories: shapes only, bounded, or undefined when there is nothing to write. */
export async function standInRequestOf(repositories: ReadonlyArray<SetupAgentRepository>, tracked: TrackedPaths, readers: typeof STANDIN_SHAPE_READERS = STANDIN_SHAPE_READERS): Promise<StandInWriterInput | undefined> {
  const [tables, operations] = await Promise.all([
    readers.tables(repositories, tracked).catch(() => [] as readonly StandInTableSeam[]),
    readers.operations(repositories, tracked).catch(() => [] as readonly StandInOperationSeam[]),
  ]);
  return buildStandInRequest(tables, operations)?.input;
}
