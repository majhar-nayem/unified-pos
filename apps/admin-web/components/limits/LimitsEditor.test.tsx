import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { LimitsEditor } from './LimitsEditor';

function Harness({
  initial = {},
  inherited,
}: {
  initial?: Record<string, string | number | boolean | string[]>;
  inherited?: Record<string, number>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <LimitsEditor value={value} onChange={setValue} inherited={inherited} />
      <output data-testid="out">{JSON.stringify(value)}</output>
    </>
  );
}
const out = () => JSON.parse(screen.getByTestId('out').textContent!);

describe('LimitsEditor', () => {
  it('adds a known limit with a typed default and lets the number be edited', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText('No limits set.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Add a limit'), 'orders.discount.max_percent');
    await user.click(screen.getByRole('button', { name: 'Add limit' }));
    expect(out()).toEqual({ 'orders.discount.max_percent': 0 });
    const input = screen.getByRole('spinbutton', { name: /Maximum discount percent/ });
    await user.clear(input);
    await user.type(input, '12.5');
    expect(out()).toEqual({ 'orders.discount.max_percent': 12.5 });
  });

  it('edits list limits as comma separated values and removes a limit', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ 'orders.price_override.allowed_categories': ['food'] }} />);
    const input = screen.getByRole('textbox', {
      name: /Catalog categories whose prices may be overridden/,
    });
    await user.clear(input);
    await user.type(input, 'food, drinks ,  ');
    expect(out()).toEqual({ 'orders.price_override.allowed_categories': ['food', 'drinks'] });
    await user.click(screen.getByRole('button', { name: /Remove limit Catalog categories/ }));
    expect(out()).toEqual({});
  });

  it('does not offer a limit that is already set and shows the inherited role default', async () => {
    render(
      <Harness
        initial={{ 'orders.refund.max_minor': 500 }}
        inherited={{ 'orders.refund.max_minor': 20000 }}
      />,
    );
    const select = screen.getByLabelText('Add a limit');
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).not.toContain(
      'orders.refund.max_minor',
    );
    expect(screen.getByText('Role default: 20000')).toBeInTheDocument();
  });

  it('supports unknown keys of every type already present on a record', () => {
    render(<Harness initial={{ 'custom.flag': false, 'custom.name': 'x' }} />);
    expect(screen.getByRole('combobox', { name: 'custom.flag' })).toHaveValue('false');
    expect(screen.getByRole('textbox', { name: 'custom.name' })).toHaveValue('x');
  });
});
