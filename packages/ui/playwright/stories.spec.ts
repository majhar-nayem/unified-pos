// Real-browser checks for every story, in both themes: axe (including colour contrast) and a pixel
// snapshot. Requires `pnpm --filter @pos/ui build-storybook` (output goes under node_modules/.cache so root lint/format ignore it) first.
import { readFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// The Storybook a11y addon also runs axe inside the story iframe; wait for it instead of colliding.
async function analyze(page: Page) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await new AxeBuilder({ page }).include('.pos-root').analyze();
    } catch (error) {
      if (attempt >= 8 || !String(error).includes('already running')) throw error;
      await page.waitForTimeout(250);
    }
  }
}

interface IndexEntry {
  id: string;
  type: string;
  tags?: string[];
}

const index = JSON.parse(
  readFileSync('node_modules/.cache/storybook-static/index.json', 'utf8'),
) as {
  entries: Record<string, IndexEntry>;
};
const stories = Object.values(index.entries).filter(
  (e) => e.type === 'story' && !e.tags?.includes('no-visual'),
);

for (const theme of ['light', 'dark'] as const) {
  for (const story of stories) {
    test(`${story.id} [${theme}]`, async ({ page }) => {
      await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`);
      await page.waitForSelector('.pos-root');
      await page.evaluate(() => document.fonts.ready);

      const axe = await analyze(page);
      expect(
        axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      ).toEqual([]);

      await expect(page).toHaveScreenshot(`${story.id}-${theme}.png`);
    });
  }
}
