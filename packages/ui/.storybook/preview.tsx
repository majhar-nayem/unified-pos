import type { Decorator, Preview } from '@storybook/react-vite';

import { UiProvider } from '../src/foundation/UiProvider.js';
import type { Surface, ThemeName } from '../src/tokens.js';

// One stylesheet in the library build (scripts/build-css.mjs); in Storybook each file loads as-is.
import.meta.glob('../src/**/*.css', { eager: true });

const withProvider: Decorator = (Story, context) => {
  const surface = (context.parameters.surface ?? context.globals.surface) as Surface;
  const theme = (context.parameters.theme ?? context.globals.theme) as ThemeName | 'auto';
  return (
    <UiProvider
      surface={surface}
      theme={theme === 'auto' ? undefined : theme}
      textScale={context.globals.textScale}
      density={context.globals.density}
    >
      <div style={{ padding: 16 }}>
        <Story />
      </div>
    </UiProvider>
  );
};

const preview: Preview = {
  decorators: [withProvider],
  initialGlobals: { surface: 'pos', theme: 'auto', textScale: 'normal', density: 'comfortable' },
  globalTypes: {
    surface: {
      description: 'Surface (type scale)',
      toolbar: { icon: 'browser', items: ['pos', 'admin', 'kds'], dynamicTitle: true },
    },
    theme: {
      description: 'Theme',
      toolbar: { icon: 'mirror', items: ['light', 'dark', 'auto'], dynamicTitle: true },
    },
    textScale: {
      description: 'Large-text mode',
      toolbar: { icon: 'zoom', items: ['normal', 'large'], dynamicTitle: true },
    },
    density: {
      description: 'Admin density',
      toolbar: { icon: 'component', items: ['comfortable', 'compact'], dynamicTitle: true },
    },
  },
  parameters: {
    layout: 'fullscreen',
    a11y: { test: 'error' },
    controls: { expanded: true },
  },
};

export default preview;
