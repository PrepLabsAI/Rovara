// Knowledge resolver (K1, C1): the readers that ship, and the registry a resolver run uses.
import { agentsMdReader, claudeMdReader } from "./agents-md.js";
import { claudeRulesReader } from "./claude-rules.js";
import { copilotInstructionsReader, copilotRepoReader } from "./copilot.js";
import { cursorReader } from "./cursor.js";
import { kiroSteeringReader } from "./kiro.js";
import { rovaraRulesReader } from "./rovara-rules.js";
import type { KnowledgeFormatReader } from "./reader.js";

/** Every built-in reader. Order decides which reader owns a path two readers both accept (none do today). */
export const BUILT_IN_READERS: readonly KnowledgeFormatReader[] = [
  agentsMdReader,
  claudeMdReader,
  kiroSteeringReader,
  cursorReader,
  copilotRepoReader,
  copilotInstructionsReader,
  claudeRulesReader,
  rovaraRulesReader,
];

export interface ReaderRegistry {
  readers: readonly KnowledgeFormatReader[];
  /** The reader that owns `path`, if any. */
  readerFor(path: string): KnowledgeFormatReader | undefined;
  /** Every directory the readers want scanned, with the readers that own it. */
  directories(): string[];
  rootFiles(): string[];
  nestedNames(): string[];
  hookDirectories(): string[];
  skillDirectories(): string[];
}

export function createReaderRegistry(readers: readonly KnowledgeFormatReader[] = BUILT_IN_READERS): ReaderRegistry {
  const unique = (values: readonly string[]): string[] => [...new Set(values)];
  return {
    readers,
    readerFor: (path) => readers.find((reader) => reader.accepts(path)),
    directories: () => unique(readers.flatMap((reader) => [...(reader.discovery.directories ?? [])])),
    rootFiles: () => unique(readers.flatMap((reader) => [...(reader.discovery.rootFiles ?? [])])),
    nestedNames: () => unique(readers.flatMap((reader) => [...(reader.discovery.nestedNames ?? [])])),
    hookDirectories: () => unique(readers.flatMap((reader) => [...(reader.discovery.hookDirectories ?? [])])),
    skillDirectories: () => unique(readers.flatMap((reader) => [...(reader.discovery.skillDirectories ?? [])])),
  };
}
