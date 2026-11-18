// The web start box's path suggestion (lead 4 J3; DEC 173): `POST /v1/app/projects/{project}/code/suggest`. The free first look (small talk gets no model call) and then the classifier model, exactly as the Slack
// intake does, for one person who has a role on the project. It starts nothing, stores nothing and returns only the kind, how the classifier went and the path the box should preselect. The model's reason is never
// returned and the person's text is never logged or echoed. Without a classifier (`route` absent) the answer is `unavailable`, and asking costs nothing.
import {
  START_SUGGESTS_PER_PERSON_PER_HOUR, START_SUGGEST_TIMEOUT_MS, START_SUGGEST_WORDS, StartSuggestRequestSchema, agentXError, pickOfKind, smallTalkOf,
  type RequestRouteKind, type RequestRouteOutcome, type StartSuggestResponse,
} from "@agentx/contracts";

/** The classifier model's router (the shape of `@agentx/orchestrator`'s `RequestRouter`, so Slack's router is usable as is). Never throws; anything unusable is an `outcome` other than `ok`. */
export type StartRouter = (text: string, signal: AbortSignal) => Promise<{ kind: RequestRouteKind; outcome: RequestRouteOutcome }>;

export interface StartSuggestDependencies {
  /** Whether the person has a role on this project now (read live: any role asks). Throws when it cannot be read; the answer is then a fixed 503. */
  mayAsk(personId: string, project: string): Promise<boolean>;
  /** The classifier. Absent: this install has none, and every suggestion says `unavailable` without asking anything. */
  route?: StartRouter | undefined;
  now: () => number;
  /** Logs a kind and an outcome only; never the text. */
  log?: ((entry: Record<string, unknown>) => void) | undefined;
  /** The most classifier calls one person may cause in an hour (default `START_SUGGESTS_PER_PERSON_PER_HOUR`). */
  limit?: number | undefined;
  timeoutMs?: number | undefined;
}

const HOUR_MS = 3_600_000;

export interface StartSuggest {
  suggest(input: { personId: string; project: string; body: unknown }): Promise<StartSuggestResponse>;
}

/** One counter per person and hour, in this process: only a classifier call takes a place, so it protects the install's own classifier and nothing else. */
export function createStartSuggestLimiter(now: () => number, limit: number): (personId: string) => boolean {
  const taken = new Map<string, number>();
  return (personId) => {
    const window = Math.floor(now() / HOUR_MS);
    for (const key of taken.keys()) if (!key.endsWith(`#${String(window)}`)) taken.delete(key);
    const key = `${personId}#${String(window)}`;
    const count = taken.get(key) ?? 0;
    if (count >= limit) return false;
    taken.set(key, count + 1);
    return true;
  };
}

/** Takes one place for the person (true: there was room). Hosted: a stored counter (async; a fault throws and is no place); the laptop: the in-process one above. */
export type StartSuggestLimiter = (personId: string) => boolean | Promise<boolean>;

export function createStartSuggest(deps: StartSuggestDependencies, limiter?: StartSuggestLimiter): StartSuggest {
  const take = limiter ?? createStartSuggestLimiter(deps.now, deps.limit ?? START_SUGGESTS_PER_PERSON_PER_HOUR);
  return {
    async suggest({ personId, project, body }) {
      // A person with no role, and a project that is not there, read the same; the role is read before the body is.
      let allowed: boolean;
      try { allowed = await deps.mayAsk(personId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", START_SUGGEST_WORDS.unavailable); }
      if (!allowed) throw agentXError("NOT_FOUND", START_SUGGEST_WORDS.projectNotFound);
      const parsed = StartSuggestRequestSchema.safeParse(body);
      if (!parsed.success) throw agentXError("CONFIG_INVALID", START_SUGGEST_WORDS.badRequest);
      const text = parsed.data.text;
      // Smart intake: small talk is a fixed reply, with no model call.
      const talk = smallTalkOf(text);
      if (talk !== undefined) return { kind: "small_talk", classifier: "ok", pick: "answer", smallTalk: talk };
      if (deps.route === undefined) return { kind: "unknown", classifier: "unavailable", pick: "answer" };
      // A counter that cannot be written is no place (fail closed): nothing is asked, and the suggestion says the classifier is unavailable.
      let placed: boolean;
      try { placed = await take(personId); } catch {
        deps.log?.({ event: "start_suggest.classified", kind: "unknown", outcome: "unavailable" });
        return { kind: "unknown", classifier: "unavailable", pick: "answer" };
      }
      if (!placed) throw agentXError("TOO_MANY_REQUESTS", START_SUGGEST_WORDS.rate);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? START_SUGGEST_TIMEOUT_MS);
      try {
        const route = await deps.route(text, controller.signal);
        deps.log?.({ event: "start_suggest.classified", kind: route.kind, outcome: route.outcome });
        if (route.outcome === "unavailable") return { kind: "unknown", classifier: "unavailable", pick: "answer" };
        if (route.outcome !== "ok") return { kind: "unknown", classifier: "failed", pick: "answer" };
        return { kind: route.kind, classifier: "ok", pick: pickOfKind(route.kind) };
      } catch {
        deps.log?.({ event: "start_suggest.classified", kind: "unknown", outcome: "invalid" });
        return { kind: "unknown", classifier: "failed", pick: "answer" };
      } finally { clearTimeout(timer); }
    },
  };
}
