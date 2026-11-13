import { hideEmailAddresses } from "@rovara-code/contracts";

// Plain one-line text for cards: no email address (S3), whatever came from a person, a plan or a repository is flattened to one line, stripped of hidden and control characters and cut at a word. Nothing here is markup.
export function plainLine(value: string, max: number): string {
  const text = hideEmailAddresses(value).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, Math.max(1, max - 1)).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** Whether a path is one a card may link to: the card contract's own rule (a path under `/app/` or `/v1/app/`, URL-safe characters only, no empty or dot segment, an optional plain query). */
export function isSafeRelativePath(value: string): boolean {
  return value.length <= 2048 && /^\/(?:v1\/)?app\/[A-Za-z0-9/_.~-]+(?:\?[A-Za-z0-9=&_.~%-]*)?$/u.test(value)
    && !value.split("?")[0]!.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === "..");
}
