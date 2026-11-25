// DEC 328: the sole item in this reserved Companies-table partition. Never store audit rows here.
import type { Dynamo } from "./dynamo.js";

export const ROVARA_AI_SETTING = Object.freeze({ pk: "INSTALL#ROVARA_AI", sk: "SETTING" });
export const ROVARA_AI_PAUSED = Object.freeze({
  ok: false as const, status: 403, code: "not_allowed",
  message: "Rovara's AI is paused on this install. Your work is safe; try again later or use your own AI source.",
});

/** Strong reads, default ON only when absent. Read failures never extend an enabled cache. */
export class InstallRovaraAi {
  private cached: { enabled: boolean; until: number } | undefined;
  constructor(private readonly db: Pick<Dynamo, "get">, private readonly table: string, private readonly now: () => number = Date.now) {}

  async enabled(): Promise<boolean> {
    const started = this.now();
    if (this.cached !== undefined && started < this.cached.until) return this.cached.enabled;
    const row = await this.db.get(this.table, ROVARA_AI_SETTING, { consistent: true });
    if (row !== undefined && (row.pk !== ROVARA_AI_SETTING.pk || row.sk !== ROVARA_AI_SETTING.sk || typeof row.enabled !== "boolean")) throw new Error("install AI setting unavailable");
    const enabled = row === undefined ? true : row.enabled === true;
    // Count read latency inside the cache window, so an old in-flight read cannot extend it.
    this.cached = { enabled, until: started + 60_000 };
    return enabled;
  }
}
