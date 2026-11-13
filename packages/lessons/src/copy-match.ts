// The ORDERED, polarity-aware comparison of two statements. The shortlist (similarity.ts) compares word SETS and so cannot tell "pnpm over npm" from "npm
// over pnpm", "tls on" from "tls off", or "3 times" from "9 times". Whatever may decide that two lessons are one (a merge by code, a rejected lesson coming back, a judge's "same", the same-mistake measure) goes
// through this module instead. Nothing here reads a store or calls a model.
//
//   verbatim   the two bodies are EQUAL after normalising case, whitespace and punctuation. Nothing else: every word, digit, negation and direction word is kept, in order.
//   near       a copy that differs only by filler: the two word sequences are EQUAL after filler is removed and a plural "s" is stemmed. No content word may differ, at any length.
//   flipped    the same words with a polarity, direction or number changed, or the same words in another order: a person decides (a contradiction card), never a merge.
//   opposed    flipped's stricter sibling: the advice really points the other way (a different stance, direction word, number, unit or antonym, or another order). A synonym swap ("disable" for
//              "turn off", "skip" for "ignore") is flipped by the word lists but NOT opposed.
//   narrows    the other lesson's words, in order, with more added: a refinement (a person decides), never a copy.
//
// A word that is in the "critical" lists below is never filler. The lists are deliberately long: a word wrongly kept as critical only sends a pair to the judge or a person, a word wrongly dropped merges advice.

/** Words that carry no advice by themselves. Everything NOT here takes part in the order test, so a changed noun, verb, preposition or digit means "not a copy". */
const FILLER: ReadonlySet<string> = new Set("a an the and is are be been it its this that these those also just too very so then please really here there you your we our as of do does did".split(" "));

/** Contractions and words that negate; all count as one "not" when polarity is compared. */
const NEGATORS: ReadonlySet<string> = new Set("not no never none nothing nobody cannot cant dont doesnt didnt wont isnt arent wasnt werent shouldnt mustnt couldnt wouldnt havent hasnt hadnt neither nor".split(" "));
/** Direction, polarity and comparison words (with the negators and every number, below). A difference in any of them is a difference in the advice. */
const POLARITY: ReadonlySet<string> = new Set((
  "always avoid prefer instead rather on off before after over than more less most least enable enabled disable disabled true false allow allowed deny denied forbid forbidden ban banned require required " +
  "skip ignore keep remove add drop include exclude start stop increase decrease higher lower above below first last must should may up down open close " +
  "zero one two three four five six seven eight nine ten once twice thrice half double single hundred thousand all every " +
  // More antonyms, the verbs of raising and cutting, and units (a changed unit changes the number's meaning).
  "block omit deactivate activate permit prevent min max minimum maximum raise cut reduce lift sync async synchronous asynchronous synchronously asynchronously public private accept reject safe unsafe " +
  "valid invalid authenticated unauthenticated deprecated ms millisecond milliseconds s sec secs second seconds minute minutes mins hour hours day days kb mb gb tb " +
  // Verbs of avoiding, more antonyms (their -ing and -ed forms are read as the verb: see `listedForm`).
  "refrain quit cease halt ascending descending ascend descend inside outside optional mandatory success failure succeed fail encrypt decrypt"
).split(" "));
/** Words that put the advice on the "do not" side (a negator counts too). Used for the STANCE of a statement: an odd number of them is a prohibition. */
const NEG_STANCE: ReadonlySet<string> = new Set("avoid skip ignore disable disabled off remove drop exclude forbid forbidden ban banned deny denied stop without block omit deactivate prevent refrain quit cease halt".split(" "));
/** Words that put the advice on the "do" side. They carry no direction, so a synonym of them ("keep" for "store") is not a change. */
const POS_STANCE: ReadonlySet<string> = new Set("always prefer enable enabled allow allowed require required keep add include start must should may on permit activate".split(" "));
const UNIT_CANON: ReadonlyMap<string, string> = new Map([
  ["millisecond", "ms"], ["milliseconds", "ms"], ["s", "sec"], ["secs", "sec"], ["second", "sec"], ["seconds", "sec"], ["mins", "minute"], ["minutes", "minute"], ["hours", "hour"], ["days", "day"],
]);
/** Prefixes that turn a word into its opposite: valid/invalid, used/unused, sync/async, blocking/nonblocking, connected/disconnected. */
const ANTONYM_PREFIXES: readonly string[] = ["un", "in", "im", "non", "a", "dis", "de"];
/**
 * Negation words of other languages that are spelt in ASCII (German, French, Dutch, Spanish, Portuguese: Italian, Norwegian, Swedish, Danish, Indonesian, Romanian, Czech, Afrikaans): this module cannot
 * classify them. "non" is tested apart (an English "non-blocking" compound is not a negation).
 */
const FOREIGN_NEGATORS: ReadonlySet<string> = new Set("nicht kein keine keinen keinem keiner nie niemals pas jamais nunca nao niet geen ikke inte jangan tidak bukan nu ne nej ingen".split(" "));
const FOREIGN_NON = /(?<![\p{L}-])non(?![\p{L}-])/iu;
/** Words that narrow or condition a statement: an added one means the statement is not the same any more. */
const QUALIFIERS: ReadonlySet<string> = new Set("except unless only but when whenever if for without otherwise besides excluding including".split(" "));

const NUMBER = /^-?\d/u;
/** Operator tokens that carry meaning in code advice. */
const SIGNS: ReadonlySet<string> = new Set(["!=", "!==", "===", "==", "<=", ">=", "&&", "||", "<>"]);
// Code operators are tokens. `!` right before an identifier, a call or a bracket is a NOT (it becomes the "not" token); `&&`, `||`, `==`, `===`, `!=`, `!==`, `<`, `>`, `<=`, `>=` and the like are sign tokens.
// A `!` after a letter, digit or closing bracket (`value!`, `a[0]!`) is TypeScript's non-null assertion or ordinary punctuation, not a negation.
const WORD = /-?\d+(?:[.,]\d+)*[\p{L}%]*|[\p{L}_][\p{L}\p{N}_]*|!==|===|!=|<=|>=|==|&&|\|\||<>|[<>=≤≥≠]|(?<![\p{L}\p{N}_)\]!])!(?=[\p{L}_([])/gu;

/** The words of a text, in order, lower case, punctuation and whitespace gone. Digits, negations and code operators are kept (`!x` is "not x"); an apostrophe inside a word is dropped (don't -> dont). */
export function wordsOf(text: string): string[] {
  const folded = text.normalize("NFKC").toLowerCase().replace(/['’`]/gu, "").replace(/[\p{Cf}\p{Cc}]/gu, " ");
  return (folded.match(WORD) ?? []).map((w) => (w === "!" ? "not" : w));
}

/** A text normalised for equality: its words joined by one space. */
export const normalizedText = (text: string): string => wordsOf(text).join(" ");

/**
 * A plural or third-person "s" is not a different word (a tier-0 lesson is written from a template: "use" becomes "uses", "retries" stays): content words lose it before the ordered comparison. Filler and every
 * critical word are left as they are. Verbatim never uses this.
 */
function stem(word: string): string {
  const listed = listedForm(word);
  if (listed !== undefined) return listed;
  if (word.length >= 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  return word.length >= 4 && word.endsWith("s") && !/(ss|us|is)$/u.test(word) ? word.slice(0, -1) : word;
}
/**
 * an -ing or -ed form of a listed word is that word ("enabling" is "enable", "skipping" is "skip", "lowered" is "lower", "decrypted" is "decrypt"). Only a form whose base is in the polarity list counts,
 * so an ordinary word that happens to end in -ing or -ed is untouched.
 */
function listedForm(word: string): string | undefined {
  for (const [suffix, extra] of [["ing", ""], ["ing", "e"], ["ed", ""], ["ed", "e"]] as const) {
    if (!word.endsWith(suffix) || word.length < suffix.length + 3) continue;
    const root = word.slice(0, -suffix.length);
    for (const base of [`${root}${extra}`, root.length > 3 && root.at(-1) === root.at(-2) ? root.slice(0, -1) : undefined]) {
      if (base !== undefined && base !== word && POLARITY.has(base) && (extra === "" || base.endsWith("e"))) return base;
    }
  }
  return undefined;
}
const forOrder = (words: readonly string[]): string[] => words.filter((w) => !FILLER.has(w)).map((w) => (isCritical(w) ? canon(w) : stem(w)));

const isNumber = (word: string): boolean => NUMBER.test(word);
const isSign = (word: string): boolean => SIGNS.has(word) || /^[<>=≤≥≠]$/u.test(word);
const isPolarity = (word: string): boolean => NEGATORS.has(word) || POLARITY.has(word) || isNumber(word) || isSign(word);
const isQualifier = (word: string): boolean => QUALIFIERS.has(word);
/** Every kind of word whose presence or place changes what the advice says. */
export const isCritical = (word: string): boolean => isPolarity(word) || isQualifier(word);
const canon = (word: string): string => (NEGATORS.has(word) ? "not" : (UNIT_CANON.get(word) ?? word));

const polaritySequence = (words: readonly string[]): string[] => words.filter(isPolarity).map(canon);
const criticalSequence = (words: readonly string[]): string[] => words.filter(isCritical).map(canon);
const sameSequence = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sortedKey = (words: readonly string[]): string => [...words].sort().join(" ");

/** The words that point somewhere: direction and comparison words, units, antonym words, numbers and signs. A stance word (do / do not) is not one. */
const directionSequence = (words: readonly string[]): string[] => words.filter((w) => isPolarity(w) && !NEGATORS.has(w) && !NEG_STANCE.has(w) && !POS_STANCE.has(w)).map(canon);
/** Whether the statement prohibits (an odd number of negating words) rather than asks. */
const isProhibition = (words: readonly string[]): boolean => words.filter((w) => NEGATORS.has(w) || NEG_STANCE.has(w)).length % 2 === 1;
/** One side has a word and the other the same word with an opposite-making prefix (valid / invalid, used / unused, sync / async). Words under four letters are not tried. */
function prefixAntonym(x: readonly string[], y: readonly string[]): boolean {
  const left = new Set(x), right = new Set(y);
  const opposes = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => { for (const w of a) if (w.length >= 4 && /^\p{L}+$/u.test(w) && ANTONYM_PREFIXES.some((p) => b.has(`${p}${w}`))) return true; return false; };
  return opposes(left, right) || opposes(right, left);
}

/** Whether a text holds a word that negates in a way this module cannot classify: any letter outside ASCII (accented, Cyrillic, CJK ...) or a known ASCII negation of another language. */
export const hasUnclassifiedNegation = (text: string): boolean => /(?=\p{L})[^\p{ASCII}]/u.test(text) || FOREIGN_NON.test(text) || wordsOf(text).some((w) => FOREIGN_NEGATORS.has(w));

/** The longest text compared word by word; a longer one is only ever called verbatim. */
const MAX_WORDS = 400;

function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) row[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, row[j - 1]!);
    previous = row;
  }
  return previous[b.length]!;
}

export interface CopyRelation {
  /** The bodies are equal after normalisation. */
  verbatim: boolean;
  /** The same words, in the same order, with only filler different: the two sequences are equal once filler is removed and plurals are stemmed. */
  near: boolean;
  /** Close in words but a polarity, direction or number differs, or the same words come in another order. */
  flipped: boolean;
  /** The FIRST text (the draft) holds all of the second's words, in order, and more: a narrowing or extension. Never a copy. */
  narrows: boolean;
  /** The advice points the other way: another stance (do / do not), direction word, unit, number or antonym, or the same words in another order. A synonym swap is not. */
  opposed: boolean;
  /** The negations, direction words and numbers are the same words (any order), and no word is the other's prefix antonym. */
  polaritySame: boolean;
  /** Negations, direction words, qualifiers (not "for") and numbers are the same words (any order): the floor under a judge's "same". */
  criticalSame: boolean;
  /** The ordered share of the longer text that the two have in common, 0 to 1. */
  ordered: number;
}

const NONE: CopyRelation = { verbatim: false, near: false, flipped: false, narrows: false, opposed: true, polaritySame: false, criticalSame: false, ordered: 0 };

export interface RelateOptions {
  /**
   * Whether a word and its prefix antonym (connecting / disconnecting) make the pair opposed. Default true: that is what stops a MERGE. The rejected-lesson match turns it off: adding a prefixed
   * word to a rejected lesson's advice must not take the draft out of the match; the match only ever leads to a person or the judge, never to a merge.
   */
  antonyms?: boolean;
}

/** How the `draft` statement relates to the `other` one, comparing their words in order. Pure; both directions are looked at (the shorter must be wholly inside the longer). */
export function relate(draft: string, other: string, options: RelateOptions = {}): CopyRelation {
  const full = [wordsOf(draft), wordsOf(other)] as const;
  if (full[0].length === 0 || full[1].length === 0) return NONE;
  const verbatim = full[0].join(" ") === full[1].join(" ");
  const x = forOrder(full[0]);
  const y = forOrder(full[1]);
  if (x.length === 0 || y.length === 0) return { ...NONE, verbatim };
  if (x.length > MAX_WORDS || y.length > MAX_WORDS) return { ...NONE, verbatim };
  const longest = Math.max(x.length, y.length);
  const shortest = Math.min(x.length, y.length);
  const common = lcsLength(x, y);
  const ordered = common / longest;
  const antonym = options.antonyms !== false && prefixAntonym(x, y);
  const polaritySame = !antonym && sortedKey(polaritySequence(x)) === sortedKey(polaritySequence(y));
  const floorCritical = (words: readonly string[]): string => sortedKey(criticalSequence(words).filter((w) => w !== "for"));
  const criticalSame = !antonym && floorCritical(x) === floorCritical(y);
  const subsequence = common === shortest;
  // A copy has EQUAL words once filler is gone. A content word added or dropped (at any length) is a different statement, not a copy.
  const near = verbatim || (shortest >= 2 && sameSequence(x, y));
  // The same words in another order ("pnpm over npm" against "npm over pnpm", "migrations before seeding" against the reverse), or close in order with a polarity, direction or number changed.
  const reordered = shortest >= 3 && x.length === y.length && sortedKey(x) === sortedKey(y) && !sameSequence(x, y);
  const polarityDiffers = antonym || !sameSequence(polaritySequence(x), polaritySequence(y));
  // One side holds the other's words in order and ADDS a negation ("Never use withRetry ... ; call fetch directly" against "Use withRetry ..."): that is the opposite advice with more words around it, not a narrowing.
  const addsNegation = subsequence && x.some((w) => NEGATORS.has(w)) !== y.some((w) => NEGATORS.has(w));
  const flipped = !near && (reordered || (polarityDiffers && (ordered >= 0.7 || addsNegation)));
  const narrows = !near && !flipped && y.length >= 4 && common === y.length && x.length > y.length;
  const opposed = !near && (reordered || antonym || isProhibition(x) !== isProhibition(y) || !sameSequence(directionSequence(x), directionSequence(y)));
  return { verbatim, near, flipped, narrows, opposed, polaritySame, criticalSame, ordered };
}

/**
 * the only test that lets a judge's "same" merge two lessons. The two texts are the same advice BY STRUCTURE, whatever a judge says: after case, punctuation, plural and -ing/-ed folding of listed words
 * and filler are normalised, they hold the SAME multiset of words (so an added, removed or swapped word of any kind, benign or not, is a difference), the same signs and operators, and their negation, direction,
 * qualifier, number and operator tokens come in the same order. Words that are only reordered are refused as before (`flipped`). It uses no antonym list: an unlisted opposite (pause / resume, show / hide) is
 * a swapped word, so it never merges. What it covers is narrow on purpose: in practice a verbatim or near copy (the same words in the same order once filler, case and plurals are set aside). It does NOT recognise a
 * paraphrase: two lessons that say the same thing in other words are never "the same" here, and go to a person as a possible duplicate (a cost in time, not in safety). Text with a negation this module cannot classify
 * (any non-ASCII word) is excluded by the caller, `closeEnoughForSame`.
 */
export function sameByStructure(a: string, b: string): boolean {
  const relation = relate(a, b);
  if (relation.verbatim || relation.near) return true;
  const x = forOrder(wordsOf(a));
  const y = forOrder(wordsOf(b));
  if (x.length === 0 || y.length === 0 || x.length > MAX_WORDS || y.length > MAX_WORDS) return false;
  return !relation.flipped && sortedKey(x) === sortedKey(y) && sameSequence(criticalSequence(x), criticalSequence(y));
}

/**
 * How much of `small` (a correction) a longer text (a lesson) says, in order: the share of `small`'s words found in the same order in `big`, and whether every negation, direction word and number of `small` is also in `big`
 * (a lesson that says "off" does not cover a correction that says "on"). Both texts are cut at MAX_WORDS words; a text cut short covers less, never more.
 */
export function covers(small: string, big: string, options: RelateOptions = {}): { ordered: number; pairs: number; polarityContained: boolean } {
  const x = forOrder(wordsOf(small)).slice(0, MAX_WORDS);
  const y = forOrder(wordsOf(big)).slice(0, MAX_WORDS);
  if (x.length === 0 || y.length === 0) return { ordered: 0, pairs: 0, polarityContained: false };
  const have = new Map<string, number>();
  for (const w of polaritySequence(y)) have.set(w, (have.get(w) ?? 0) + 1);
  const polarityContained = (options.antonyms === false || !prefixAntonym(x, y)) && polaritySequence(x).every((w) => { const n = have.get(w) ?? 0; have.set(w, n - 1); return n > 0; });
  // Two words swapped keep most of the order (the longest common run is only one word short) but break the pairs of neighbours around them: the share of `small`'s neighbouring pairs found in `big` (`pairs`) is part of the answer.
  const pairs = new Set(y.slice(1).map((w, i) => `${y[i]} ${w}`));
  const wanted = x.slice(1).map((w, i) => `${x[i]} ${w}`);
  const pairShare = wanted.length === 0 ? 1 : wanted.filter((pair) => pairs.has(pair)).length / wanted.length;
  return { ordered: lcsLength(x, y) / x.length, pairs: pairShare, polarityContained };
}
