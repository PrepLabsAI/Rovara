export interface EndedTasks { isEnded(issuer: string, company: string, task: string, signal?: AbortSignal): Promise<boolean> }
/**
 * The write side of the ended-task record (task-ended-notice.ts is its only caller). Idempotent and one-way: `true` when this call
 * recorded the end, `false` when the task was already recorded as ended. A record is never changed or removed by a later notice.
 */
export interface EndedTaskRecorder { record(issuer: string, company: string, task: string, signal?: AbortSignal): Promise<boolean> }
/** Every task record belongs to an install AND company. */
export class InMemoryEndedTasks implements EndedTasks, EndedTaskRecorder {
  readonly #ended = new Set<string>();
  end(issuer: string, company: string, task: string): void { this.#ended.add(JSON.stringify([issuer, company, task])); }
  async record(issuer: string, company: string, task: string): Promise<boolean> {
    const key = JSON.stringify([issuer, company, task]);
    if (this.#ended.has(key)) return false;
    this.#ended.add(key); return true;
  }
  async isEnded(issuer: string, company: string, task: string): Promise<boolean> { return this.#ended.has(JSON.stringify([issuer, company, task])); }
}
