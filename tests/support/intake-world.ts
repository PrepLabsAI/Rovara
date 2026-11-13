// A document store for the intake tests: the memory store, plus a record of every key written so a test can look at what is kept (`find`). The sweep never runs (the clock of a test is not the real one).
import type { DocumentKey, StoredDocument, TransactItem } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";

export class RecordingStore extends MemoryDocumentStore {
  readonly #written = new Map<string, DocumentKey>();

  constructor() {
    super({ nowSeconds: () => 0 });
  }

  #note(key: DocumentKey): void {
    this.#written.set(`${key.pk}\u0000${key.sk}`, { pk: key.pk, sk: key.sk });
  }

  override async put(request: Parameters<MemoryDocumentStore["put"]>[0]): ReturnType<MemoryDocumentStore["put"]> {
    this.#note(request.item);
    return super.put(request);
  }

  override async update(request: Parameters<MemoryDocumentStore["update"]>[0]): ReturnType<MemoryDocumentStore["update"]> {
    this.#note(request.key);
    return super.update(request);
  }

  override async transact(items: readonly TransactItem[]): ReturnType<MemoryDocumentStore["transact"]> {
    for (const item of items) this.#note(item.kind === "put" ? item.item : item.key);
    return super.transact(items);
  }

  /** Every document that is there and matches. */
  async find(predicate: (item: StoredDocument) => boolean): Promise<StoredDocument[]> {
    const found: StoredDocument[] = [];
    for (const key of this.#written.values()) {
      const item = await this.get(key);
      if (item !== undefined && predicate(item)) found.push(item);
    }
    return found;
  }
}
