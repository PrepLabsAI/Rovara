// The one seam between a lesson's deletion or erasure and the lessons file. The file itself cannot change until the team merges a pull request, so erasure only PROPOSES
// removals in the next weekly pass. One case is exact: a lesson that is only an add (or an edit) in Rovara's OPEN pull request is taken out at once, by closing that pull request and deleting its branch, so the erased text never
// reaches the default branch; the next weekly pass opens a fresh one without it. The broker plugs `closeOpenPullRequestFor` in at handler start, only where the lessons file is wired. Ids only; it never throws into a deletion.
import type { ScopeKey } from "./store.js";

type Listener = (key: ScopeKey, lessonId: string) => Promise<void>;
let listener: Listener | undefined;
export function setLessonGoneListener(next: Listener | undefined): void { listener = next; }
export async function notifyLessonGone(key: ScopeKey, lessonId: string): Promise<void> {
  try { await listener?.(key, lessonId); } catch { /* the deletion never waits on the file; the next weekly pass removes what the file holds */ }
}
