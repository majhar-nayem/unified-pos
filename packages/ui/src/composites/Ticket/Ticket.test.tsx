import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../test/render.js';
import { catalogs } from '../../i18n/catalogs.generated.js';

import {
  Ticket,
  ageBucket,
  defaultAgeThresholds,
  nextTicketAction,
  type TicketProps,
} from './Ticket.js';

describe('ageBucket', () => {
  it('defaults to 300 / 480 / 600 seconds', () => {
    expect(defaultAgeThresholds).toEqual({
      agingSeconds: 300,
      lateSeconds: 480,
      criticalSeconds: 600,
    });
    expect(ageBucket(0)).toBe('fresh');
    expect(ageBucket(299)).toBe('fresh');
    expect(ageBucket(300)).toBe('aging');
    expect(ageBucket(479)).toBe('aging');
    expect(ageBucket(480)).toBe('late');
    expect(ageBucket(599)).toBe('late');
    expect(ageBucket(600)).toBe('critical');
    expect(ageBucket(10_000)).toBe('critical');
  });

  it('honours per-station thresholds and falls back for missing fields', () => {
    const station = { agingSeconds: 60, lateSeconds: 120, criticalSeconds: 180 };
    expect(ageBucket(59, station)).toBe('fresh');
    expect(ageBucket(60, station)).toBe('aging');
    expect(ageBucket(120, station)).toBe('late');
    expect(ageBucket(180, station)).toBe('critical');
    expect(ageBucket(100, { agingSeconds: 60 })).toBe('aging');
    expect(ageBucket(500, { agingSeconds: 60 })).toBe('late');
  });
});

describe('nextTicketAction', () => {
  it('maps status to the primary action', () => {
    expect(nextTicketAction('new')).toBe('start');
    expect(nextTicketAction('fired')).toBe('start');
    expect(nextTicketAction('in-progress')).toBe('ready');
    expect(nextTicketAction('ready')).toBe('bump');
  });
});

const base: TicketProps = {
  number: 231,
  source: 'T12',
  customer: 'Marco',
  guests: 4,
  ageSeconds: 192,
  status: 'in-progress',
  items: [{ id: 'a', quantity: 1, name: 'Burger Lg', modifiers: ['+ cheese'] }],
};

describe('Ticket', () => {
  it('renders number, source, age, meta and items', () => {
    renderUi(<Ticket {...base} courseLabel="Course 2" />);
    const ticket = screen.getByRole('article', { name: 'Ticket 231, T12, In progress' });
    expect(within(ticket).getByText('#231')).toBeInTheDocument();
    expect(within(ticket).getByText('T12')).toBeInTheDocument();
    expect(within(ticket).getByText('3:12')).toBeInTheDocument();
    expect(within(ticket).getByText('Marco · 4 guests')).toBeInTheDocument();
    expect(within(ticket).getByText('Course 2')).toBeInTheDocument();
    expect(within(ticket).getByText('Burger Lg')).toBeInTheDocument();
    expect(within(ticket).getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it.each([
    [10, 'fresh', 'Fresh'],
    [350, 'aging', 'Aging'],
    [500, 'late', 'Late'],
    [700, 'critical', 'Critical'],
  ] as const)(
    'age %s uses the %s palette with an icon and a text label',
    (ageSeconds, bucket, label) => {
      renderUi(<Ticket {...base} ageSeconds={ageSeconds} />);
      const ticket = screen.getByRole('article');
      expect(ticket).toHaveAttribute('data-palette', `kds-age-${bucket}`);
      expect(ticket).toHaveAttribute('data-bucket', bucket);
      expect(within(ticket).getByText(label)).toBeInTheDocument();
      expect(ticket.querySelector('.pos-ticket__age svg')).toBeInTheDocument();
    },
  );

  it('uses per-station thresholds', () => {
    renderUi(
      <Ticket
        {...base}
        ageSeconds={130}
        thresholds={{ agingSeconds: 60, lateSeconds: 120, criticalSeconds: 180 }}
      />,
    );
    expect(screen.getByRole('article')).toHaveAttribute('data-bucket', 'late');
  });

  it('shows the UPDATED badge only when updated', () => {
    const { rerender } = renderUi(<Ticket {...base} />);
    expect(screen.queryByText('UPDATED')).not.toBeInTheDocument();
    rerender(<Ticket {...base} updated />);
    expect(screen.getByText('UPDATED')).toBeInTheDocument();
  });

  it.each([
    ['new', 'start', 'Start'],
    ['fired', 'start', 'Start'],
    ['in-progress', 'ready', 'Ready'],
    ['ready', 'bump', 'Bump'],
  ] as const)('status %s offers %s', async (status, action, label) => {
    const onAction = vi.fn();
    renderUi(<Ticket {...base} status={status} onAction={onAction} />);
    const button = screen.getByRole('button', { name: `${label} ticket 231` });
    expect(button).toHaveTextContent(label);
    await userEvent.click(button);
    expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
  });

  it('the primary action is at least the bump height and is the only control: a ticket cannot be removed', () => {
    renderUi(<Ticket {...base} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: /remove|delete|dismiss|close/i }),
    ).not.toBeInTheDocument();
  });

  it('forwards voided announcements from items', () => {
    const onVoidedAnnounce = vi.fn();
    const item = { id: 'a', quantity: 1, name: 'Fish' };
    const { rerender } = renderUi(
      <Ticket {...base} items={[item]} onVoidedAnnounce={onVoidedAnnounce} />,
    );
    rerender(
      <Ticket {...base} items={[{ ...item, voided: true }]} onVoidedAnnounce={onVoidedAnnounce} />,
    );
    expect(onVoidedAnnounce).toHaveBeenCalledOnce();
    expect(screen.getByText('Item voided: 1 × Fish')).toBeInTheDocument();
  });

  it('has KDS copy catalogued', () => {
    expect(
      Object.keys(catalogs['en-AU']).filter((key) => key.startsWith('ticket')).length,
    ).toBeGreaterThan(10);
  });
});
