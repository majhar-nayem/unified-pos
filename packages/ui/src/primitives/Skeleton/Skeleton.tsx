import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

import { cx } from '../../foundation/cx.js';
import { useUi } from '../../foundation/UiProvider.js';

export type SkeletonVariant = 'text' | 'block' | 'circle';

export interface SkeletonProps {
  readonly variant?: SkeletonVariant;
  /** Number of text lines (variant `text`). The last line is shorter. Default 1. */
  readonly lines?: number;
  /** CSS width, or a number of px. */
  readonly width?: number | string;
  /** CSS height, or a number of px (block and circle). */
  readonly height?: number | string;
  readonly className?: string;
}

/**
 * Static loading placeholder: no shimmer or pulse (nothing animates on the checkout path). Always
 * `aria-hidden`; wrap placeholders in a SkeletonGroup so assistive tech hears "Loading…" once.
 */
export function Skeleton({ variant = 'text', lines = 1, width, height, className }: SkeletonProps) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  if (variant === 'text' && lines > 1) {
    return (
      <span className={cx('pos-skeleton-lines', className)} aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => (
          <span
            key={index}
            className="pos-skeleton pos-skeleton--text"
            data-last={index === lines - 1 ? '' : undefined}
            style={index === lines - 1 ? undefined : style}
          />
        ))}
      </span>
    );
  }
  return (
    <span
      className={cx('pos-skeleton', `pos-skeleton--${variant}`, className)}
      style={style}
      aria-hidden="true"
    />
  );
}

export interface SkeletonGroupProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
}

/** Wraps placeholders and announces a single visually hidden "Loading…" status. */
export function SkeletonGroup({ className, children, ...rest }: SkeletonGroupProps) {
  const { t } = useUi();
  return (
    <div {...rest} className={cx('pos-skeleton-group', className)} role="status">
      <span className="pos-sr-only">{t('ui.loading')}</span>
      {children}
    </div>
  );
}
