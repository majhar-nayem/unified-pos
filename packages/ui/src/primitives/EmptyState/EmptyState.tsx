import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Decorative icon; defaults to a list icon. Pass `null` for none. */
  readonly icon?: ReactNode;
  /** Defaults to the catalogued "Nothing here yet". */
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** Call to action, typically a Button. */
  readonly action?: ReactNode;
  /** Heading level for the title so it fits the page outline. Default 3. */
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6;
}

/** "Nothing here" placeholder with an optional next step. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  headingLevel = 3,
  className,
  ...rest
}: EmptyStateProps) {
  const { t } = useUi();
  const Heading = `h${headingLevel}` as const;
  return (
    <div {...rest} className={cx('pos-empty', className)}>
      {icon === null ? null : (
        <div className="pos-empty__icon">{icon ?? <Icon name="list" size="1.5em" />}</div>
      )}
      <Heading className="pos-empty__title">{title ?? t('emptyState.title')}</Heading>
      {description ? <p className="pos-empty__description">{description}</p> : null}
      {action ? <div className="pos-empty__action">{action}</div> : null}
    </div>
  );
}
