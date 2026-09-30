// packages/cli/src/init/ui/cards.ts
// What each screen of the install page says (spec 040 FR-020 to FR-041, and phase 3's finishing
// screens). Every card is built here, from facts a step already has, so the page's words are
// tested in one place and the page only lays text out. No builder takes a secret, so no card can
// carry one (FR-012).
import type { WizardCard } from "./protocol.js";

/** A button's label for an address the run opens: "Open github.com". */
export function linkLabel(url: string): string {
  try {
    return `Open ${new URL(url).host}`;
  } catch {
    return "Open the address";
  }
}

// Unused until Task 3 adds the first card builder; keeps the import honest for lint.
export type { WizardCard };
