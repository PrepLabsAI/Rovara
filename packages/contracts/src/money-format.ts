// Display only, not a policy range or permission check. Callers validate their domain limits.
// BigInt/string arithmetic preserves every micro even at Number.MAX_SAFE_INTEGER.
export function formatUsdMicrodollars(value: number): string {
 if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Expected a nonnegative safe integer amount.");
 const micros = BigInt(value), whole = (micros / 1_000_000n).toString();
 const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
 return "$" + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + fraction;
}
