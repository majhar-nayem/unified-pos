import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button/Button.js';
import { StatusPill } from '../StatusPill/StatusPill.js';
import { Tag } from '../Tag/Tag.js';

import { Card } from './Card.js';

const frame: Decorator = (Story) => (
  <div style={{ maxWidth: 420 }}>
    <Story />
  </div>
);

const meta = {
  title: 'Primitives/Card',
  component: Card,
  args: { children: 'Card body content.' },
  decorators: [frame],
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BodyOnly: Story = {};
export const WithHeader: Story = {
  args: { header: <span>Today&apos;s sales</span>, children: 'AUD 4,210.50 across 132 orders.' },
};
export const WithHeaderAndFooter: Story = {
  args: {
    header: (
      <>
        <span>Table 12</span>
        <StatusPill tone="warning" label="Awaiting payment" />
      </>
    ),
    children: '4 guests, 3 courses fired.',
    footer: (
      <>
        <Button variant="ghost">Split</Button>
        <Button>Take payment</Button>
      </>
    ),
  },
};
export const Interactive: Story = {
  args: {
    interactive: true,
    onClick: () => undefined,
    header: <span>Flat white</span>,
    children: (
      <>
        AUD 4.50 <Tag tone="info">Hot</Tag>
      </>
    ),
  },
};
export const InteractiveLink: Story = {
  args: {
    interactive: true,
    href: '#orders',
    header: <span>Open orders</span>,
    children: '12 open checks.',
  },
};
export const InteractiveDisabled: Story = {
  args: {
    interactive: true,
    disabled: true,
    header: <span>Sold out</span>,
    children: 'Unavailable today.',
  },
};
export const LongContent: Story = {
  args: {
    header: <span>Long header text that should wrap neatly rather than overflow the card</span>,
    children: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6),
  },
};
