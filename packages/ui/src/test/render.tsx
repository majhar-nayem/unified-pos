import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

import { UiProvider, type UiProviderProps } from '../foundation/UiProvider.js';

/** Renders inside a UiProvider so locale, theme and portals behave as in an app. */
export function renderUi(
  ui: ReactElement,
  providerProps: Omit<UiProviderProps, 'children'> = {},
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => <UiProvider {...providerProps}>{children}</UiProvider>,
    ...options,
  });
}
