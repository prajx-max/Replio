export function select(
  root: ParentNode,
  candidates: string[],
): { element: HTMLElement | null; index: number } {
  for (const [index, candidate] of candidates.entries()) {
    try {
      const element = root.querySelector<HTMLElement>(candidate);
      if (element) return { element, index };
    } catch {
      /* Invalid CSS is data; try the next fallback. */
    }
  }
  return { element: null, index: -1 };
}
export function matches(element: Element, candidates: string[]): boolean {
  return candidates.some((selector) => {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  });
}
