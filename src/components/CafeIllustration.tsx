/**
 * Flat vector cafe storefront used on the login panel and dashboard.
 * Drawn inline so it stays sharp at any size and needs no image assets.
 */
export function CafeIllustration({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 260 220" fill="none" className={className} aria-hidden="true">
      {/* ground shadow */}
      <ellipse cx="130" cy="200" rx="100" ry="12" fill="#F0C582" opacity="0.55" />

      {/* trees */}
      <circle cx="34" cy="150" r="20" fill="#F0C582" stroke="#5E3A1F" strokeWidth="2" />
      <rect x="30" y="164" width="8" height="28" rx="2" fill="#5E3A1F" />
      <circle cx="226" cy="150" r="20" fill="#F0C582" stroke="#5E3A1F" strokeWidth="2" />
      <rect x="222" y="164" width="8" height="28" rx="2" fill="#5E3A1F" />

      {/* sign board */}
      <rect x="94" y="50" width="72" height="28" rx="14" fill="#5E3A1F" />
      <rect x="115" y="59" width="20" height="13" rx="3" fill="#F5D5A8" />
      <path
        d="M135 62h4a3.5 3.5 0 0 1 0 7h-4"
        stroke="#F5D5A8"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M120 56c0-2 3-2 3-4M128 56c0-2 3-2 3-4"
        stroke="#F5D5A8"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.8"
      />

      {/* building body */}
      <rect
        x="56"
        y="88"
        width="148"
        height="104"
        rx="6"
        fill="#FFFFFF"
        stroke="#5E3A1F"
        strokeWidth="2"
      />

      {/* awning */}
      <path
        d="M46 90Q130 60 214 90V108H46Z"
        fill="#E8B563"
        stroke="#5E3A1F"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M74 82v26M102 75v33M130 71v37M158 75v33M186 82v26"
        stroke="#5E3A1F"
        strokeWidth="1.5"
        opacity="0.45"
      />

      {/* windows */}
      <rect
        x="68"
        y="120"
        width="34"
        height="42"
        rx="4"
        fill="#FDF3E3"
        stroke="#5E3A1F"
        strokeWidth="2"
      />
      <path d="M68 141h34M85 120v42" stroke="#5E3A1F" strokeWidth="1.5" opacity="0.4" />

      <rect
        x="158"
        y="120"
        width="34"
        height="42"
        rx="4"
        fill="#FDF3E3"
        stroke="#5E3A1F"
        strokeWidth="2"
      />
      <path d="M158 141h34M175 120v42" stroke="#5E3A1F" strokeWidth="1.5" opacity="0.4" />

      {/* door */}
      <rect
        x="110"
        y="132"
        width="40"
        height="60"
        rx="4"
        fill="#FDF3E3"
        stroke="#5E3A1F"
        strokeWidth="2"
      />
      <circle cx="142" cy="162" r="2.5" fill="#5E3A1F" />

      {/* planter boxes */}
      <rect x="66" y="166" width="38" height="12" rx="3" fill="#F0C582" stroke="#5E3A1F" strokeWidth="2" />
      <path d="M76 166v-8M85 166v-11M94 166v-8" stroke="#5E3A1F" strokeWidth="1.5" strokeLinecap="round" />

      <rect x="156" y="166" width="38" height="12" rx="3" fill="#F0C582" stroke="#5E3A1F" strokeWidth="2" />
      <path d="M166 166v-8M175 166v-11M184 166v-8" stroke="#5E3A1F" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Small coffee cup mark used in the sidebar header. */
export function CupMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M8 4c0-1 1.5-1 1.5-2M12 4c0-1 1.5-1 1.5-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  );
}
