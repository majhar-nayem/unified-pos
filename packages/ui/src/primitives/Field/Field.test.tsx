import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Field, fieldDescribedBy, useFieldIds, type FieldProps } from './Field.js';

function Demo(props: Omit<FieldProps, 'ids' | 'children'>) {
  const ids = useFieldIds();
  return (
    <Field ids={ids} {...props}>
      <input
        id={ids.controlId}
        aria-describedby={fieldDescribedBy(ids, { hint: props.hint, error: props.error })}
      />
    </Field>
  );
}

describe('Field', () => {
  it('associates the label with the control', () => {
    renderUi(<Demo label="Store name" />);
    expect(screen.getByLabelText('Store name')).toBeInstanceOf(HTMLInputElement);
  });

  it('describes the control by its hint and error', () => {
    renderUi(<Demo label="Store" hint="Shown on receipts" error="Required" />);
    const input = screen.getByLabelText('Store');
    expect(input).toHaveAccessibleDescription('Shown on receipts Required');
  });

  it('omits aria-describedby when there is no hint or error', () => {
    renderUi(<Demo label="Store" />);
    expect(screen.getByLabelText('Store')).not.toHaveAttribute('aria-describedby');
  });

  it('shows a required marker that is hidden from assistive tech', () => {
    renderUi(<Demo label="Store" required />);
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows the optional marker through t()', () => {
    renderUi(<Demo label="Store" optional />);
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });

  it('prefers the required marker over optional', () => {
    renderUi(<Demo label="Store" optional required />);
    expect(screen.queryByText('(optional)')).not.toBeInTheDocument();
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('hides the label visually but keeps it accessible', () => {
    renderUi(<Demo label="Store" hideLabel />);
    expect(screen.getByText('Store')).toHaveClass('pos-sr-only');
    expect(screen.getByLabelText('Store')).toBeInTheDocument();
  });

  it('renders an error with an icon and text', () => {
    const { container } = renderUi(<Demo label="Store" error="Enter a name" />);
    expect(screen.getByText('Enter a name')).toBeVisible();
    expect(container.querySelector('.pos-field__error svg')).not.toBeNull();
  });

  it('renders a fieldset with a legend for groups', () => {
    renderUi(
      <Field
        ids={{ controlId: 'g', labelId: 'g-label', hintId: 'g-hint', errorId: 'g-error' }}
        label="Group"
        as="fieldset"
        hint="Pick one"
      >
        <span>content</span>
      </Field>,
    );
    const group = screen.getByRole('group', { name: 'Group' });
    expect(group).toHaveAccessibleDescription('Pick one');
  });
});
