// #1211: the side-effect-free part of the per-test coverage recorder (tests/support/coverage-map-setup.ts), kept apart so it can be tested.

export interface CoverageRange { startOffset: number; endOffset: number; count: number }

/** Product code only: a package's src, never its tests or anything in node_modules. */
export function isProductScript(url: string): boolean {
  return /\/packages\/[^/]+\/src\//u.test(url) && !url.includes("/node_modules/") && !/\.test\.[cm]?[jt]s$/u.test(url);
}

/**
 * The executed regions of one script, as sorted, merged [start, end) offset intervals. V8 reports a function range and, inside it, block ranges whose
 * count differs from their parent's; an offset ran when the innermost range around it has a count above zero. Nested functions are ranges of their own.
 */
export function executedIntervals(ranges: readonly CoverageRange[]): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const result: Array<[number, number]> = [];
  const emit = (start: number, end: number, count: number): void => {
    if (end <= start || count <= 0) return;
    const last = result[result.length - 1];
    if (last !== undefined && last[1] >= start) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  };
  const stack: CoverageRange[] = [];
  let position = 0;
  for (const range of sorted) {
    while (stack.length > 0 && stack[stack.length - 1]!.endOffset <= range.startOffset) {
      const top = stack.pop()!;
      emit(position, top.endOffset, top.count);
      position = top.endOffset;
    }
    if (stack.length > 0) emit(position, range.startOffset, stack[stack.length - 1]!.count);
    position = range.startOffset;
    stack.push(range);
  }
  while (stack.length > 0) {
    const top = stack.pop()!;
    emit(position, top.endOffset, top.count);
    position = top.endOffset;
  }
  return result;
}

