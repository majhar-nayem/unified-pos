// Every story is a test: it must render and pass axe. Stories are the single source of component states
// (docs/04-design-plan.md section 8), so a new state added in a story is covered with no extra work.
import { composeStories } from '@storybook/react-vite';
import { render } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';

import * as preview from '../.storybook/preview.js';

import { axeViolations } from './test/a11y.js';

const modules = import.meta.glob('./**/*.stories.tsx', { eager: true }) as Record<
  string,
  Parameters<typeof composeStories>[0]
>;

for (const [path, mod] of Object.entries(modules)) {
  const stories = composeStories(mod, preview.default) as Record<string, ComponentType>;
  describe(path.replace('./', ''), () => {
    for (const [name, Story] of Object.entries(stories)) {
      it(`${name} renders without axe violations`, async () => {
        const { container } = render(<Story />);
        expect(container).not.toBeEmptyDOMElement();
        expect(await axeViolations(document.body)).toEqual([]);
      });
    }
  });
}
