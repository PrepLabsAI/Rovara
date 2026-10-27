// Shared by the reviewers' fix-proposal check (review.ts) and the test proof (test-proof.ts).

/**
 * A path common test layouts use: a test/, tests/, __tests__/, spec/ or e2e/ directory, or a *.test.*, *.spec.*,
 * *_test.*, *_spec.* or test_*.py file.
 */
export function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return parts.slice(0, -1).some(part => ["test", "tests", "__tests__", "spec", "e2e"].includes(part))
    || /\.(?:test|spec)\.[^./]+$/.test(name) || /_(?:test|spec)\.[^./]+$/.test(name) || /^test_.+\.py$/.test(name);
}
