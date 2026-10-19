import type { Meta, StoryObj } from '@storybook/react-vite';

import { Field, useFieldIds, fieldDescribedBy, type FieldProps } from './Field.js';

type DemoProps = Omit<FieldProps, 'ids' | 'children'>;

/** A bare native input wired to Field, to show the label, hint and error plumbing on its own. */
function Demo({ error, hint, ...props }: DemoProps) {
  const ids = useFieldIds();
  return (
    <Field ids={ids} hint={hint} error={error} {...props}>
      <input
        id={ids.controlId}
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldDescribedBy(ids, { hint, error })}
        required={props.required}
      />
    </Field>
  );
}

const meta = {
  title: 'Primitives/Field',
  component: Demo,
  args: { label: 'Store name' },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithHint: Story = { args: { hint: 'Shown on receipts and the customer display.' } };
export const WithError: Story = { args: { error: 'Enter a store name.' } };
export const Required: Story = { args: { required: true } };
export const Optional: Story = { args: { optional: true } };
export const HiddenLabel: Story = { args: { hideLabel: true } };
export const LongContent: Story = {
  args: {
    label:
      'A very long label that describes exactly what the person is expected to type into this field',
    hint: 'A long hint that keeps going so the wrapping behaviour of the hint paragraph can be reviewed in narrow layouts.',
    error:
      'A long error message that explains in detail what went wrong and how to fix it before trying again.',
  },
};
