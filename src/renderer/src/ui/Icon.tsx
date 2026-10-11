import type { ReactNode } from 'react';

export type IconName =
  | 'arrow-left'
  | 'arrow-right'
  | 'refresh'
  | 'plus'
  | 'sparkles'
  | 'bookmark'
  | 'research'
  | 'activity'
  | 'settings'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'search'
  | 'globe'
  | 'chevron-right'
  | 'chevron-down'
  | 'shield'
  | 'close'
  | 'check'
  | 'file'
  | 'folder'
  | 'clock'
  | 'message'
  | 'external-link';

const shapes: Record<IconName, ReactNode> = {
  'arrow-left': <path d="M19 12H5m7-7-7 7 7 7" />,
  'arrow-right': <path d="M5 12h14m-7-7 7 7-7 7" />,
  refresh: <path d="M20 7v5h-5M4 17v-5h5m10.2-4a8 8 0 0 0-13.4-2M4.8 16a8 8 0 0 0 13.4 2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  sparkles: (
    <path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Zm7-1v4m-2-2h4" />
  ),
  bookmark: <path d="M6 4h12v17l-6-4-6 4V4Z" />,
  research: (
    <>
      <path d="M13 3H5v18h14v-8M8 7h3M8 11h2M8 16h4" />
      <circle cx="16" cy="7" r="3" />
      <path d="m18.2 9.2 3 3" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  settings: (
    <>
      <path d="M9.5 3h5l.6 2.4 2 .9 2.2-.7 2.5 4.3-1.7 1.7v2.3l1.7 1.7-2.5 4.3-2.2-.7-2 .9-.6 2.4h-5L8.9 20l-2-.9-2.2.7-2.5-4.3 1.7-1.7v-2.3L2.2 9.8l2.5-4.3 2.2.7 2-.9L9.5 3Z" />
      <circle cx="12" cy="12.5" r="3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </>
  ),
  moon: <path d="M20.4 14A9 9 0 0 1 10 3.6 9 9 0 1 0 20.4 14Z" />,
  monitor: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M12 16v5m-4 0h8" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'chevron-down': <path d="m5 9 7 7 7-7" />,
  shield: <path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Zm-4 9 3 3 5-6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  file: <path d="M13 3H5v18h14V9l-6-6Zm0 0v6h6M8 13h8m-8 4h6" />,
  folder: <path d="M3 7V5h6l2 3h10v12H3V7Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  message: <path d="M4 4h16v13H9l-5 4V4Zm4 5h8m-8 4h5" />,
  'external-link': <path d="M14 3h7v7m0-7L11 13m-1-8H4v15h15v-6" />,
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 18, className = '' }: IconProps) {
  return (
    <svg
      className={`ui-icon${className === '' ? '' : ` ${className}`}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes[name]}
    </svg>
  );
}
