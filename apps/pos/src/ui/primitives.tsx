import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'default' | 'primary' | 'danger';

/**
 * App-local button (the @pos/ui Button lands separately; swap here when it does). A `disabled`
 * button uses aria-disabled so it stays focusable and can explain itself through `title`.
 */
export function Button({
  variant = 'default',
  tender,
  unavailable,
  className = '',
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  tender?: boolean;
  unavailable?: boolean;
  children: ReactNode;
}) {
  const classes = [
    variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : '',
    tender ? 'btn-tender' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      {...rest}
      aria-disabled={unavailable || rest.disabled ? true : undefined}
      onClick={unavailable ? undefined : onClick}
    >
      {children}
    </button>
  );
}

export function Banner({
  tone,
  role = 'status',
  children,
}: {
  tone: 'warning' | 'info' | 'danger';
  role?: 'status' | 'alert';
  children: ReactNode;
}) {
  return (
    <div className={`banner banner--${tone}`} role={role}>
      {children}
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? (
        <span id={`${id}-hint`} className="muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
}
