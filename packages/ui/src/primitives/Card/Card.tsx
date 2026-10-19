import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from '../../foundation/cx.js';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** Header slot, e.g. a title and a Tag. */
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
  /** Semantic root for a non-interactive card. */
  readonly as?: 'div' | 'section' | 'article';
  /**
   * Makes the whole card one press target: a link with `href`, otherwise a button.
   * Do not nest other interactive controls inside an interactive card.
   */
  readonly interactive?: boolean;
  readonly href?: string;
  /** Interactive button cards only. */
  readonly disabled?: boolean;
  readonly target?: string;
  readonly rel?: string;
}

/** Surface with optional header, body and footer slots. */
export function Card({
  header,
  footer,
  children,
  className,
  as: Root = 'div',
  interactive = false,
  href,
  disabled,
  target,
  rel,
  ...rest
}: CardProps) {
  if (interactive) {
    // Phrasing content only inside <button>/<a>, so slots are spans.
    const body = (
      <>
        {header ? <span className="pos-card__header">{header}</span> : null}
        {children ? <span className="pos-card__body">{children}</span> : null}
        {footer ? <span className="pos-card__footer">{footer}</span> : null}
      </>
    );
    const classes = cx('pos-card', 'pos-card--interactive', className);
    if (href !== undefined) {
      return (
        <a {...rest} href={href} target={target} rel={rel} className={classes}>
          {body}
        </a>
      );
    }
    return (
      <button type="button" {...rest} disabled={disabled} className={classes}>
        {body}
      </button>
    );
  }
  return (
    <Root {...rest} className={cx('pos-card', className)}>
      {header ? <div className="pos-card__header">{header}</div> : null}
      {children ? <div className="pos-card__body">{children}</div> : null}
      {footer ? <div className="pos-card__footer">{footer}</div> : null}
    </Root>
  );
}
