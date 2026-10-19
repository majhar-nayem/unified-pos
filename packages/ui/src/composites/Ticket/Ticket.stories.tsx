import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Ticket, type TicketAction, type TicketStatus } from './Ticket.js';
import type { TicketItemProps } from './TicketItem.js';

const burger: TicketItemProps[] = [
  { id: 'a', quantity: 1, name: 'Burger Lg', modifiers: ['+ cheese', 'no onion'] },
  { id: 'b', quantity: 1, name: 'Fish' },
];

const meta = {
  title: 'KDS/Ticket',
  component: Ticket,
  parameters: { surface: 'kds' },
  args: {
    number: 231,
    source: 'T12',
    customer: 'Marco',
    guests: 4,
    ageSeconds: 192,
    status: 'in-progress',
    items: burger,
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Ticket>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Fresh: Story = {};
export const Aging: Story = {
  args: {
    number: 232,
    source: 'TA',
    customer: undefined,
    guests: undefined,
    ageSeconds: 350,
    status: 'new',
  },
};
export const Late: Story = {
  args: {
    number: 228,
    source: 'T4',
    customer: 'Lena',
    guests: 2,
    ageSeconds: 500,
    status: 'ready',
  },
};
export const Critical: Story = {
  args: { number: 228, source: 'T4', customer: 'Lena', guests: 2, ageSeconds: 631 },
};
export const Fired: Story = {
  args: {
    number: 233,
    source: 'T7',
    ageSeconds: 45,
    status: 'fired',
    courseLabel: 'Course 2',
    guests: undefined,
    customer: undefined,
  },
};
export const Delivery: Story = {
  args: {
    number: 234,
    source: 'DEL',
    customer: 'Uber Eats',
    guests: undefined,
    ageSeconds: 10,
    status: 'new',
    items: [
      { id: 'a', quantity: 3, name: 'Burger Reg' },
      { id: 'b', quantity: 1, name: 'no cheese' },
      { id: 'c', quantity: 1, name: 'Steak M' },
    ],
  },
};
export const WithAllergy: Story = {
  args: {
    number: 232,
    source: 'TA',
    ageSeconds: 350,
    items: [
      { id: 'a', quantity: 2, name: 'Burger Reg', allergy: 'nut' },
      { id: 'b', quantity: 1, name: 'Fish' },
    ],
  },
};
export const UpdatedWithVoid: Story = {
  args: {
    updated: true,
    items: [
      {
        id: 'a',
        quantity: 1,
        name: 'Burger Lg',
        modifiers: ['+ cheese', { label: 'no onion', changed: true }],
        changed: true,
      },
      { id: 'b', quantity: 1, name: 'Fish', voided: true, voidedAt: new Date(2026, 0, 1, 19, 12) },
    ],
  },
};
export const StationThresholds: Story = {
  name: 'Custom thresholds (60/120/180)',
  args: {
    ageSeconds: 130,
    thresholds: { agingSeconds: 60, lateSeconds: 120, criticalSeconds: 180 },
  },
};
export const Light: Story = {
  parameters: { surface: 'kds', theme: 'light' },
  args: { ageSeconds: 500, status: 'ready' },
};

const order: TicketStatus[] = ['new', 'in-progress', 'ready'];
export const Interactive: Story = {
  render: function InteractiveStory(args) {
    const [status, setStatus] = useState<TicketStatus>('new');
    const [bumped, setBumped] = useState(false);
    const onAction = (action: TicketAction) => {
      if (action === 'bump') setBumped(true);
      else setStatus(order[order.indexOf(status) + 1] ?? 'ready');
    };
    return bumped ? (
      <p>Bumped. Recall from the recall drawer.</p>
    ) : (
      <Ticket {...args} status={status} onAction={onAction} />
    );
  },
};
