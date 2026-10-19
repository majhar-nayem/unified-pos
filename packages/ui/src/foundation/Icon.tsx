import type { ReactNode, SVGProps } from 'react';

import { cx } from './cx.js';

/** Stroke icons on a 24 grid. Status UI pairs an icon with a label; icons are decorative by default. */
const paths = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" />,
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3L12 4z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  /** Static half-filled circle: indeterminate progress without animation on the checkout path. */
  processing: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 010 18z" fill="currentColor" />
    </>
  ),
  hourglass: <path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 8s-8 3-8 8M16 4c0 5-8 5-8 8" />,
  wifi: (
    <>
      <path d="M3 9a14 14 0 0118 0M6 12.5a9.5 9.5 0 0112 0M9 16a5 5 0 016 0" />
      <path d="M12 19.5v.5" />
    </>
  ),
  'wifi-off': (
    <>
      <path d="M3 9a14 14 0 013-2M21 9a14 14 0 00-8-3.9M6 12.5a9.5 9.5 0 013-1.8M18 12.5a9.5 9.5 0 00-3-1.8M9 16a5 5 0 016 0" />
      <path d="M12 19.5v.5M4 4l16 16" />
    </>
  ),
  cloud: <path d="M7 18a4 4 0 010-8 5.5 5.5 0 0110.5 1.5A3.3 3.3 0 0117 18H7z" />,
  'cloud-off': (
    <>
      <path d="M7 18a4 4 0 010-8 5.5 5.5 0 011.5-.9M17.5 11.5A3.3 3.3 0 0117 18H9" />
      <path d="M4 4l16 16" />
    </>
  ),
  sync: (
    <>
      <path d="M4 12a8 8 0 0113.7-5.6L20 8.5M20 4v4.5h-4.5" />
      <path d="M20 12a8 8 0 01-13.7 5.6L4 15.5M4 20v-4.5h4.5" />
    </>
  ),
  'chevron-down': <path d="M6 9.5l6 6 6-6" />,
  'chevron-up': <path d="M6 14.5l6-6 6 6" />,
  'chevron-left': <path d="M14.5 6l-6 6 6 6" />,
  'chevron-right': <path d="M9.5 6l6 6-6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />,
  backspace: <path d="M9 6h11v12H9l-6-6 6-6zM12.5 9.5l5 5M17.5 9.5l-5 5" />,
  card: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18M7 15h3" />
    </>
  ),
  cash: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1-4 4-6 8-6s7 2 8 6" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15L6 16zM10 20h4" />,
  printer: (
    <>
      <path d="M7 9V4h10v5M7 17H4v-7h16v7h-3" />
      <rect x="7" y="14" width="10" height="6" />
    </>
  ),
  flag: <path d="M6 21V4M6 5h11l-2 4 2 4H6" />,
  ban: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </>
  ),
  send: <path d="M4 12l16-8-6 17-3-7-7-2z" />,
  scan: (
    <path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M7 9v6M11 9v6M14 9v6M17 9v6" />
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="18" cy="12" r="1" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  edit: <path d="M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3" />,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6" />,
  list: <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.5M4.5 12h.5M4.5 17h.5" />,
  undo: <path d="M9 7L4 12l5 5M4 12h10a6 6 0 010 8h-2" />,
  utensils: <path d="M7 3v8M5 3v5a2 2 0 004 0V3M7 11v10M17 21V3c-2 1-3 4-3 8h3" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;
export const iconNames = Object.keys(paths) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  readonly name: IconName;
  /** CSS size (px number or length). Defaults to 1.25em so it tracks the surrounding text. */
  readonly size?: number | string;
  /** Provide only for an icon that carries meaning on its own; otherwise the icon is aria-hidden. */
  readonly title?: string;
}

export function Icon({ name, size = '1.25em', title, className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx('pos-icon', className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
