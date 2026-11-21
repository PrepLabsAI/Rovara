// Plan 2, Task 17: the Public Suffix List's matching rules (https://publicsuffix.org/list/), over the rules generated into
// public-suffix-rules.ts. Importing this module eagerly materializes PUBLIC_SUFFIX_RULES; callers that only need
// isPublicSuffix / registrableDomain get lazy initialization via ./public-suffix-matcher.js (re-exported by @agentx/contracts).
import { getPublicSuffixRules } from "./public-suffix-rules.js";

export {
  PUBLIC_SUFFIX_LIST_COMMIT,
  createPublicSuffixMatcher,
  getPublicSuffixRules,
  isPublicSuffix,
  registrableDomain,
  type PublicSuffixMatcher,
} from "./public-suffix-matcher.js";

export const PUBLIC_SUFFIX_RULES: ReadonlySet<string> = getPublicSuffixRules();
