import axe from 'axe-core';

/**
 * Runs axe on a rendered fragment and returns a readable list of violations (empty when clean).
 * jsdom has no layout, so colour contrast is excluded here; it is covered by the token contrast test
 * and by the real-browser axe run in playwright/stories.spec.ts.
 */
export async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map(
    (v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}
