import type { Meta, StoryObj } from '@storybook/react-vite';

import { TicketItem } from './TicketItem.js';

const meta = {
  title: 'KDS/TicketItem',
  component: TicketItem,
  parameters: { surface: 'kds' },
  args: { quantity: 1, name: 'Burger Lg' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TicketItem>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithModifiers: Story = { args: { modifiers: ['+ cheese', 'no onion'] } };
export const WithNotes: Story = { args: { modifiers: ['no lemon'], notes: 'Customer in a hurry' } };
export const Allergy: Story = { args: { quantity: 2, name: 'Burger Reg', allergy: 'nut' } };
export const MultipleAllergens: Story = {
  args: { name: 'Fish', allergy: ['nut', 'dairy', 'egg'] },
};
export const Voided: Story = {
  args: {
    name: 'Steak MR',
    modifiers: ['peppercorn sauce'],
    voided: true,
    voidedAt: new Date(2026, 0, 1, 19, 12),
  },
};
export const VoidedNoTime: Story = { args: { name: 'Steak W', voided: true } };
export const Changed: Story = { args: { name: 'Fish', modifiers: ['no lemon'], changed: true } };
export const ChangedModifier: Story = {
  args: {
    name: 'Burger Lg',
    modifiers: ['+ cheese', { label: 'no onion', changed: true }],
  },
};
export const LongContent: Story = {
  args: {
    quantity: 12,
    name: 'Slow-braised wagyu short rib burger with smoked paprika aioli',
    modifiers: [
      'substitute gluten-free bun and extra-long-modifier-text-without-breaks-supercalifragilistic',
    ],
    allergy: 'gluten, sesame, tree nuts',
    notes: 'Please keep separate from the shared fryer',
  },
};
export const Light: Story = {
  parameters: { surface: 'kds', theme: 'light' },
  args: { name: 'Burger Reg', modifiers: ['+ cheese'], allergy: 'nut', changed: true },
};
