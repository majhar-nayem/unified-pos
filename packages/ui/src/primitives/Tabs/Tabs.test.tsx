import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Tabs, type TabItem } from './Tabs.js';

const items: TabItem[] = [
  { value: 'a', label: 'Alpha', content: <p>Alpha panel</p> },
  { value: 'b', label: 'Beta', content: <p>Beta panel</p> },
  { value: 'c', label: 'Gamma', content: <p>Gamma panel</p> },
];

describe('Tabs', () => {
  it('has tablist, tabs and a labelled panel with the first tab selected', () => {
    renderUi(<Tabs items={items} aria-label="Sections" />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument();
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'false');
    const panel = screen.getByRole('tabpanel', { name: 'Alpha' });
    expect(panel).toHaveTextContent('Alpha panel');
    expect(alpha).toHaveAttribute('aria-controls', panel.id);
  });

  it('uses roving tabindex', () => {
    renderUi(<Tabs items={items} aria-label="Sections" />);
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('tabindex', '-1');
  });

  it('activates on arrow keys, wrapping, with Home and End', async () => {
    const user = userEvent.setup();
    renderUi(<Tabs items={items} aria-label="Sections" />);
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Beta panel');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
  });

  it('skips disabled tabs when navigating', async () => {
    const user = userEvent.setup();
    renderUi(
      <Tabs
        aria-label="Sections"
        items={items.map((item) => (item.value === 'b' ? { ...item, disabled: true } : item))}
      />,
    );
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveFocus();
  });

  it('selects on click and calls onValueChange (uncontrolled)', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderUi(
      <Tabs items={items} aria-label="Sections" onValueChange={onValueChange} defaultValue="b" />,
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Beta panel');
    await user.click(screen.getByRole('tab', { name: 'Gamma' }));
    expect(onValueChange).toHaveBeenCalledWith('c');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Gamma panel');
  });

  it('is controllable', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [value, setValue] = useState('a');
      return <Tabs items={items} aria-label="Sections" value={value} onValueChange={setValue} />;
    }
    renderUi(<Controlled />);
    await user.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');

    const onValueChange = vi.fn();
    renderUi(<Tabs items={items} aria-label="Fixed" value="a" onValueChange={onValueChange} />);
    const fixed = screen.getAllByRole('tablist', { name: 'Fixed' })[0]!;
    await user.click(fixed.querySelectorAll('[role="tab"]')[1]!);
    expect(onValueChange).toHaveBeenCalledWith('b');
    expect(fixed.querySelectorAll('[role="tab"]')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('shows an optional count badge and announces it through t()', () => {
    renderUi(
      <Tabs
        aria-label="Sections"
        items={[
          { value: 'a', label: 'Open', count: 12 },
          { value: 'b', label: 'Held', count: 1 },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Open 12 items' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Held 1 item' })).toBeInTheDocument();
  });
});
