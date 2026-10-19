import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Toggle } from './Toggle.js';

describe('Toggle', () => {
  it('is a named switch', () => {
    renderUi(<Toggle label="Sound alerts" />);
    const toggle = screen.getByRole('switch', { name: 'Sound alerts' });
    expect(toggle).not.toBeChecked();
  });

  it('reflects defaultChecked', () => {
    renderUi(<Toggle label="Sound alerts" defaultChecked />);
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('toggles on click and reports the new state', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    renderUi(<Toggle label="Sound" onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it('toggles with Space from the keyboard', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    renderUi(<Toggle label="Sound" onCheckedChange={onCheckedChange} />);
    await user.tab();
    await user.keyboard(' ');
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
  });

  it('toggles when its label text is clicked', async () => {
    const user = userEvent.setup();
    renderUi(<Toggle label="Sound" />);
    await user.click(screen.getByText('Sound'));
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('is controlled via checked', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [checked, setChecked] = useState(false);
      return <Toggle label="Sound" checked={checked} onCheckedChange={setChecked} />;
    }
    renderUi(<Controlled />);
    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('does not change when disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    renderUi(<Toggle label="Sound" disabled onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('accepts aria-label without visible text', () => {
    renderUi(<Toggle aria-label="Sound alerts" />);
    expect(screen.getByRole('switch', { name: 'Sound alerts' })).toBeInTheDocument();
  });
});
