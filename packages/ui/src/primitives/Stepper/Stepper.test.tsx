import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Stepper, type StepperStep } from './Stepper.js';

const steps: StepperStep[] = [
  { id: 'a', label: 'Upload' },
  { id: 'b', label: 'Map', description: 'Match columns' },
  { id: 'c', label: 'Review' },
];

describe('Stepper', () => {
  it('is a named ordered list of steps', () => {
    renderUi(<Stepper steps={steps} current={0} />);
    const list = screen.getByRole('list', { name: 'Progress' });
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  it('marks only the current step with aria-current="step"', () => {
    renderUi(<Stepper steps={steps} current={1} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).not.toHaveAttribute('aria-current');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[2]).not.toHaveAttribute('aria-current');
  });

  it('derives complete, current and upcoming states with text, not colour alone', () => {
    renderUi(<Stepper steps={steps} current={1} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Upload, Completed');
    expect(items[1]).toHaveTextContent('Map, Current step');
    expect(items[2]).toHaveTextContent('Review, Not started');
    expect(items[0]).toHaveClass('pos-stepper__item--complete');
    expect(items[0]?.querySelector('svg')).not.toBeNull();
  });

  it('shows step numbers for current and upcoming steps', () => {
    renderUi(<Stepper steps={steps} current={0} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('supports an explicit error state with icon and text', () => {
    renderUi(
      <Stepper steps={[steps[0]!, { ...steps[1]!, state: 'error' }, steps[2]!]} current={1} />,
    );
    const item = screen.getAllByRole('listitem')[1];
    expect(item).toHaveTextContent('Map, Needs attention');
    expect(item).toHaveClass('pos-stepper__item--error');
    expect(item?.querySelector('svg')).not.toBeNull();
  });

  it('renders descriptions', () => {
    renderUi(<Stepper steps={steps} current={0} />);
    expect(screen.getByText('Match columns')).toBeInTheDocument();
  });

  it('is not interactive without onStepClick', () => {
    renderUi(<Stepper steps={steps} current={2} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('makes reached steps buttons and keeps upcoming steps inert', async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();
    renderUi(<Stepper steps={steps} current={1} onStepClick={onStepClick} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /Upload/ }));
    expect(onStepClick).toHaveBeenCalledWith(0, steps[0]);
    await user.click(screen.getByText('Review'));
    expect(onStepClick).toHaveBeenCalledTimes(1);
  });

  it('operates clickable steps from the keyboard', async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();
    renderUi(<Stepper steps={steps} current={2} onStepClick={onStepClick} />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onStepClick).toHaveBeenCalledWith(0, steps[0]);
  });

  it('respects per-step disabled', () => {
    renderUi(
      <Stepper
        steps={[{ ...steps[0]!, disabled: true }, steps[1]!, steps[2]!]}
        current={2}
        onStepClick={() => {}}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Upload/ })).not.toBeInTheDocument();
  });

  it('supports orientation and a custom label', () => {
    const { container } = renderUi(
      <Stepper steps={steps} current={0} orientation="vertical" label="Import progress" />,
    );
    expect(screen.getByRole('list', { name: 'Import progress' })).toBeInTheDocument();
    expect(container.querySelector('.pos-stepper--vertical')).not.toBeNull();
  });
});
