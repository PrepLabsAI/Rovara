// Plan 2, Task 17: the Public Suffix List's matching rules (https://publicsuffix.org/list/), over the rules generated into
// public-suffix-rules.ts. A project's allowed domains must not name a public suffix, or a wildcard over one: such an entry would let the
// machines reach every site beneath it, which belong to other people.
import { PUBLIC_SUFFIX_LIST_COMMIT, PUBLIC_SUFFIX_RULES } from "./public-suffix-rules.js";

export { PUBLIC_SUFFIX_LIST_COMMIT, PUBLIC_SUFFIX_RULES };

const LABEL = /^[a-z0-9_-]+$/;

/** The labels of a name in ASCII (punycode for an international name), lower-cased, without one trailing dot; undefined when it is no name. */
function labelsOf(domain: string): string[] | undefined {
  const lowered = domain.toLowerCase();
  const labels = (lowered.endsWith(".") ? lowered.slice(0, -1) : lowered).split(".");
  return labels.every((label) => LABEL.test(label)) ? labels : undefined;
}

export interface PublicSuffixMatcher {
  /** True when the name is itself a public suffix (`com`, `co.uk`, `github.io`). A name with an empty label or a character no name has is not one. */
  isPublicSuffix: (domain: string) => boolean;
  /** The public suffix plus one label (`acme.co.uk` for `www.acme.co.uk`); undefined for a public suffix and for an invalid name. */
  registrableDomain: (domain: string) => string | undefined;
}

/**
 * The list's algorithm over a set of rules (`a.b`, `*.a.b` and `!a.b`): an exception rule that matches wins, and its suffix is the rule
 * without its leftmost label; otherwise the rule matching the most labels wins, and a name no rule matches falls to the default rule `*`,
 * which makes its last label the suffix.
 */
export function createPublicSuffixMatcher(rules: ReadonlySet<string>): PublicSuffixMatcher {
  /** How many of the name's last labels are its public suffix. */
  const suffixLength = (labels: readonly string[]): number => {
    let longest = 1;
    for (let start = 0; start < labels.length; start += 1) {
      const candidate = labels.slice(start).join(".");
      if (rules.has(`!${candidate}`)) return labels.length - start - 1;
      if (rules.has(candidate)) longest = Math.max(longest, labels.length - start);
      if (start + 1 < labels.length && rules.has(`*.${labels.slice(start + 1).join(".")}`)) longest = Math.max(longest, labels.length - start);
    }
    return longest;
  };
  return {
    isPublicSuffix: (domain) => {
      const labels = labelsOf(domain);
      return labels !== undefined && labels.length <= suffixLength(labels);
    },
    registrableDomain: (domain) => {
      const labels = labelsOf(domain);
      if (labels === undefined) return undefined;
      const length = suffixLength(labels);
      return labels.length > length ? labels.slice(labels.length - length - 1).join(".") : undefined;
    },
  };
}

const matcher = createPublicSuffixMatcher(PUBLIC_SUFFIX_RULES);
export const isPublicSuffix = matcher.isPublicSuffix;
export const registrableDomain = matcher.registrableDomain;
