import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Checkbox } from './Checkbox.js';

function SelectAllDemo() {
  const [items, setItems] = useState({ a: true, b: false, c: false });
  const values = Object.values(items);
  const all = values.every(Boolean);
  const none = values.every((v) => !v);
  return (
    <div role="group" aria-label="Products">
      <Checkbox
        label="All products"
        checked={all}
        indeterminate={!all && !none}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          setItems({ a: next, b: next, c: next });
        }}
      />
      {(['a', 'b', 'c'] as const).map((key) => (
        <Checkbox
          key={key}
          label={`Product ${key.toUpperCase()}`}
          checked={items[key]}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            setItems((prev) => ({ ...prev, [key]: next }));
          }}
        />
      ))}
    </div>
  );
}

const meta = {
  title: 'Primitives/Checkbox',
  component: Checkbox,
  args: { label: 'Email me the receipt' },
} satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {};
export const Checked: Story = { args: { defaultChecked: true } };
export const Indeterminate: Story = { args: { indeterminate: true, label: 'Select all products' } };
export const WithHint: Story = {
  args: { hint: 'A copy goes to the address on the customer record.' },
};
export const Invalid: Story = { args: { invalid: true, label: 'I accept the terms' } };
export const Disabled: Story = { args: { disabled: true } };
export const DisabledChecked: Story = { args: { disabled: true, defaultChecked: true } };
export const AriaLabelOnly: Story = { args: { label: undefined, 'aria-label': 'Select row 3' } };
export const SelectAll: Story = { render: () => <SelectAllDemo /> };
