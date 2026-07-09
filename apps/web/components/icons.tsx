import type { SVGProps } from "react";

/**
 * Unified icon set — consistent 24px grid, 1.75 stroke, round caps/joins.
 * Premium, legible at small sizes (Lucide/Heroicons-style geometry).
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  home: (p: IconProps) => <Svg {...p}><path d="M3 11.5 12 4l9 7.5" /><path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" /></Svg>,
  guide: (p: IconProps) => <Svg {...p}><path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M15 3v5h5" /></Svg>,
  crawl: (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></Svg>,
  operations: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></Svg>,
  download: (p: IconProps) => <Svg {...p}><path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></Svg>,
  university: (p: IconProps) => <Svg {...p}><path d="M3 9.5 12 4l9 5.5" /><path d="M5 10v8h14v-8" /><path d="M9 18v-4h6v4" /></Svg>,
  link: (p: IconProps) => <Svg {...p}><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></Svg>,
  logs: (p: IconProps) => <Svg {...p}><path d="M4 6h16M4 12h16M4 18h10" /></Svg>,
  settings: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 15H4.5a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.6V4.5a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.1a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.2 1z" /></Svg>,
  shield: (p: IconProps) => <Svg {...p}><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" /><path d="m9 12 2 2 4-4" /></Svg>,
  bot: (p: IconProps) => <Svg {...p}><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4M9 14h.01M15 14h.01M2 13h2M20 13h2" /></Svg>,
  pulse: (p: IconProps) => <Svg {...p}><path d="M3 12h4l2 6 4-14 2 8h6" /></Svg>,
  course: (p: IconProps) => <Svg {...p}><path d="M4 19V5a2 2 0 0 1 2-2h10l4 4v12" /><path d="M8 7h6M8 11h8M8 15h5" /></Svg>,
  external: (p: IconProps) => <Svg {...p}><path d="M14 4h6v6M20 4l-9 9" /><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" /></Svg>,
  globe: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></Svg>,
  check: (p: IconProps) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>,
  database: (p: IconProps) => <Svg {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></Svg>,
  lock: (p: IconProps) => <Svg {...p}><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>,
  users: (p: IconProps) => <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.6" /><path d="M15.5 14.2c2.3.5 4 2.5 4.5 5.8" /></Svg>,
};

export type IconName = keyof typeof Icons;
