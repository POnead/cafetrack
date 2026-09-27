/**
 * Inline stroke icons for the sidebar and toolbars.
 *
 * Drawn with `currentColor` on a 24x24 grid so they inherit the surrounding
 * text colour, match the 1.8px stroke already used elsewhere in the UI, and
 * stay sharp at any size — no icon font or image assets.
 */
import type { ReactNode } from "react";

export type IconProps = { className?: string };

function Icon({ className = "", children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** House — the "Home" nav entry. */
export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 10.4 12 4l8 6.4V19a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 19v-8.6Z" />
      <path d="M9.6 20.4v-5.2h4.8v5.2" />
    </Icon>
  );
}

/** Shopping cart — checkout & restock. */
export function CartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 4h2l2.3 10.2a1.6 1.6 0 0 0 1.5 1.3h8a1.6 1.6 0 0 0 1.6-1.2L20 7H6" />
      <circle cx="9.5" cy="19" r="1.3" />
      <circle cx="17.5" cy="19" r="1.3" />
    </Icon>
  );
}

/** Boxed cube — inventory items. */
export function BoxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.2 20 7v10l-8 3.8L4 17V7l8-3.8Z" />
      <path d="M4 7l8 3.8L20 7" />
      <path d="M12 10.8v10" />
    </Icon>
  );
}

/** Bell — alerts. */
export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 9.6a5.5 5.5 0 0 1 11 0c0 4 1.5 5.4 1.5 5.4H5s1.5-1.4 1.5-5.4Z" />
      <path d="M10 18.6a2 2 0 0 0 4 0" />
    </Icon>
  );
}

/** Two people — staff accounts. */
export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9.7" cy="8.2" r="3.2" />
      <path d="M4 20v-1.6a3.4 3.4 0 0 1 3.4-3.4h4.6a3.4 3.4 0 0 1 3.4 3.4V20" />
      <path d="M15.3 5.3a3.2 3.2 0 0 1 0 5.8" />
      <path d="M20 20v-1.6a3.4 3.4 0 0 0-2.5-3.3" />
    </Icon>
  );
}

/** Bars — reports & analytics. */
export function ChartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20h16" />
      <path d="M7 20v-8.5" />
      <path d="M12 20V5" />
      <path d="M17 20v-5.5" />
    </Icon>
  );
}

/** Shield with a tick — audit trail. */
export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.4 19 6v5.6c0 4.2-2.8 7.3-7 9-4.2-1.7-7-4.8-7-9V6l7-2.6Z" />
      <path d="m9.3 12.1 2 2 3.5-3.7" />
    </Icon>
  );
}

/** Door with an arrow — log out. */
export function LogOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 16.5V19A1.5 1.5 0 0 1 13 20.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5h7A1.5 1.5 0 0 1 14.5 5v2.5" />
      <path d="M11.5 12h9" />
      <path d="m17.5 8.5 3.5 3.5-3.5 3.5" />
    </Icon>
  );
}
