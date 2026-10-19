import type { HTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import type { SemanticRole } from '../../tokens.js';

export type TagTone = 'neutral' | SemanticRole;

export interface TagProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Colour role. `neutral` is the default. A Tag labels or categorises; it is NOT a status indicator (use StatusPill). */
  readonly tone?: TagTone;
  /** When set, the tag shows a remove button that calls this. */
  readonly onRemove?: () => void;
  /** Accessible name for the remove button. Defaults to "Remove {children}" when children is plain text. */
  readonly removeLabel?: string;
  readonly size?: 'sm' | 'md';
  readonly ref?: Ref<HTMLSpanElement>;
  readonly children: ReactNode;
}

export function Tag({
  tone = 'neutral',
  onRemove,
  removeLabel,
  size = 'md',
  className,
  children,
  ref,
  ...rest
}: TagProps) {
  const { t } = useUi();
  const text = typeof children === 'string' || typeof children === 'number' ? String(children) : '';
  const removeName =
    removeLabel ?? (text ? t('tag.remove', { label: text }) : t('tag.removeGeneric'));
  return (
    <span
      {...rest}
      ref={ref}
      className={cx('pos-tag', `pos-tag--${size}`, className)}
      data-tone={tone}
    >
      <span className="pos-tag__label">{children}</span>
      {onRemove ? (
        <button
          type="button"
          className="pos-tag__remove"
          aria-label={removeName}
          onClick={onRemove}
        >
          <Icon name="x" size="1em" />
        </button>
      ) : null}
    </span>
  );
}
