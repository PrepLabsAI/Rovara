export interface EndedTasks { isEnded(issuer: string, company: string, task: string, signal?: AbortSignal): Promise<boolean> }
/** No notice endpoint in R3a. Every task record belongs to an install AND company. */
export class InMemoryEndedTasks implements EndedTasks {
  readonly #ended = new Set<string>();
  end(issuer: string, company: string, task: string): void { this.#ended.add(JSON.stringify([issuer, company, task])); }
  async isEnded(issuer: string, company: string, task: string): Promise<boolean> { return this.#ended.has(JSON.stringify([issuer, company, task])); }
}
