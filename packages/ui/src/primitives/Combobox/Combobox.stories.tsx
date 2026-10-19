import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Combobox, type ComboboxOption, type ComboboxProps } from './Combobox.js';

const options: ComboboxOption[] = [
  { value: 'cappuccino', label: 'Cappuccino', description: '$4.50' },
  { value: 'flat-white', label: 'Flat white', description: '$4.50' },
  { value: 'latte', label: 'Latte', description: '$4.80' },
  { value: 'long-black', label: 'Long black', description: '$4.00' },
  { value: 'mocha', label: 'Mocha', description: '$5.20', disabled: true },
];

function ControlledCombobox(props: ComboboxProps) {
  const [value, setValue] = useState<string | null>(null);
  const [text, setText] = useState('');
  return (
    <Combobox
      {...props}
      value={value}
      inputValue={text}
      onInputChange={setText}
      onSelect={(option) => setValue(option.value)}
    />
  );
}

const meta: Meta<typeof Combobox> = {
  title: 'Primitives/Combobox',
  component: Combobox,
  args: { label: 'Product', options, placeholder: 'Start typing' },
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div style={{ minHeight: 360 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Combobox>;

export const Default: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
export const Selected: Story = { args: { defaultValue: 'latte' } };
export const OpenWithSelection: Story = { args: { defaultOpen: true, defaultValue: 'latte' } };
export const Loading: Story = { args: { defaultOpen: true, loading: true, options: [] } };
export const LoadingWithResults: Story = {
  args: { defaultOpen: true, loading: true, filter: false },
};
export const Empty: Story = { args: { defaultOpen: true, options: [] } };
export const CustomEmpty: Story = {
  args: { defaultOpen: true, options: [], emptyMessage: 'No product matches. Try a barcode.' },
};
export const WithHint: Story = { args: { hint: 'Type a name, SKU or barcode.' } };
export const Invalid: Story = { args: { error: 'Choose a product.' } };
export const Required: Story = { args: { required: true } };
export const Disabled: Story = { args: { disabled: true, defaultValue: 'latte' } };
export const ReadOnly: Story = { args: { readOnly: true, defaultValue: 'latte' } };
export const Controlled: Story = { render: (args) => <ControlledCombobox {...args} /> };
