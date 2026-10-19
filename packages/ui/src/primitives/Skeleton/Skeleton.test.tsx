import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderUi } from '../../test/render.js';

import { Skeleton, SkeletonGroup } from './Skeleton.js';

describe('Skeleton', () => {
  it('shapes are aria-hidden', () => {
    const { container } = renderUi(
      <>
        <Skeleton />
        <Skeleton variant="block" />
        <Skeleton variant="circle" />
      </>,
    );
    const shapes = container.querySelectorAll('.pos-skeleton');
    expect(shapes).toHaveLength(3);
    shapes.forEach((shape) => expect(shape).toHaveAttribute('aria-hidden', 'true'));
  });

  it('group announces a single visually hidden Loading status via t()', () => {
    renderUi(
      <SkeletonGroup>
        <Skeleton lines={3} />
        <Skeleton variant="circle" />
      </SkeletonGroup>,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading…');
    expect(screen.getAllByText('Loading…')).toHaveLength(1);
  });

  it('renders the requested number of text lines and sizes', () => {
    const { container } = renderUi(<Skeleton lines={4} width={120} />);
    expect(container.querySelectorAll('.pos-skeleton--text')).toHaveLength(4);
    const block = renderUi(
      <Skeleton variant="block" width={200} height={40} />,
    ).container.querySelector<HTMLElement>('.pos-skeleton--block')!;
    expect(block.style.width).toBe('200px');
    expect(block.style.height).toBe('40px');
  });

  it('has no animation hooks (static placeholder)', () => {
    const { container } = renderUi(<Skeleton variant="block" />);
    expect(
      container.querySelector('[class*="shimmer"], [class*="pulse"], [class*="animate"]'),
    ).toBeNull();
  });
});
