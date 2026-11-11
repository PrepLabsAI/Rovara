// What the records of the browser and API checks are written to: the document store, and a clock a test can set. Every record function takes this as its store argument, where Cloud's took the
// DynamoDB client and table name.
import type { DocumentStore, StoredDocument } from "@agentx/contracts";

export type E2EStateStore = Readonly<{ store: DocumentStore; now?: () => Date }>;

/** The time a record is stamped with. */
export const stampOf = (deps: Pick<E2EStateStore, "now">): string => (deps.now?.() ?? new Date()).toISOString();

/** A record built from plain values, as the store holds it. */
export const asDocument = (row: Record<string, unknown>): StoredDocument => row as StoredDocument;

/** Whether `value` carries the mark only the verifier of that kind of round puts on what it returns (a symbol key whose description is `mark`), so a record is never written from rows a caller made up. */
export const isVerifiedBy = (value: object, mark: string): boolean => Object.getOwnPropertySymbols(value).some((symbol) => symbol.description === mark && (value as Record<symbol, unknown>)[symbol] === true);
