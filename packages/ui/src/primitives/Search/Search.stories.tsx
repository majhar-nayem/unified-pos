import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Search, type SearchProps } from './Search.js';

function ScannerDemo(props: SearchProps) {
  const [last, setLast] = useState<string | null>(null);
  return (
    <div>
      <Search {...props} onScan={setLast} captureGlobally />
      <p role="status">{last ? `Scanned ${last}` : 'Waiting for a scan'}</p>
    </div>
  );
}

function ControlledSearch(props: SearchProps) {
  const [query, setQuery] = useState('');
  return <Search {...props} value={query} onQueryChange={setQuery} />;
}

const meta = {
  title: 'Primitives/Search',
  component: Search,
  args: { placeholder: 'Search products or scan a barcode' },
} satisfies Meta<typeof Search>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithValue: Story = { args: { defaultValue: 'flat white' } };
export const VisibleLabel: Story = { args: { hideLabel: false, label: 'Find a product' } };
export const Large: Story = { args: { size: 'lg' } };
export const Disabled: Story = { args: { disabled: true } };
export const WithError: Story = {
  args: { error: 'No product matches that barcode.', defaultValue: '9300000000000' },
};
export const ScannerCapture: Story = { render: (args) => <ScannerDemo {...args} /> };
export const Interactive: Story = { render: (args) => <ControlledSearch {...args} /> };
