import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: string;
}

/** Empty states say what the list is for and what to do next, never just "No data". */
export function EmptyState({ title, description, action, icon = '◻' }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h3 className="empty-title">{title}</h3>
      {description ? <p className="empty-description">{description}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
