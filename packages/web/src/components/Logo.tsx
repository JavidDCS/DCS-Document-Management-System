export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0"
      aria-hidden="true"
    >
      {/* --- TOP HALF: GOLDEN SUN WITH RADIATING RAYS --- */}
      {/* Central Sun Arc */}
      <path
        d="M 10 16.5 A 8 8 0 0 1 26 16.5 Z"
        fill="#F59E0B"
      />
      {/* 7 Sun Rays */}
      {/* Center top ray */}
      <path d="M 17 4 L 19 4 L 18.5 8.5 L 17.5 8.5 Z" fill="#F59E0B" />
      {/* Top-left ray */}
      <path d="M 11.2 5.8 L 12.8 4.6 L 15 8.8 L 14 9.6 Z" fill="#F59E0B" />
      {/* Top-right ray */}
      <path d="M 23.2 4.6 L 24.8 5.8 L 22 9.6 L 21 8.8 Z" fill="#F59E0B" />
      {/* Mid-left ray */}
      <path d="M 6.4 10.2 L 7.6 8.8 L 11.8 11.8 L 11 12.8 Z" fill="#F59E0B" />
      {/* Mid-right ray */}
      <path d="M 28.4 8.8 L 29.6 10.2 L 25 12.8 L 24.2 11.8 Z" fill="#F59E0B" />
      {/* Far-left ray */}
      <path d="M 4 15.5 L 4.5 14 L 9.5 15 L 9.5 16.2 Z" fill="#F59E0B" />
      {/* Far-right ray */}
      <path d="M 31.5 14 L 32 15.5 L 26.5 16.2 L 26.5 15 Z" fill="#F59E0B" />

      {/* --- BOTTOM HALF: SOLAR PHOTOVOLTAIC PANEL GRID --- */}
      {/* Curved semicircle panel array */}
      <clipPath id="panel-clip">
        <path d="M 4 18.5 C 4 26.5 10 32.5 18 32.5 C 26 32.5 32 26.5 32 18.5 Z" />
      </clipPath>

      <g clipPath="url(#panel-clip)">
        {/* Deep Solar Blue Base */}
        <rect x="3" y="17" width="30" height="17" fill="#006DAE" />

        {/* Concentric curved grid lat lines */}
        <path d="M 3 23 C 10 24.5 26 24.5 33 23" stroke="#FFFFFF" strokeWidth="0.85" fill="none" opacity="0.9" />
        <path d="M 5 27.5 C 11 29 25 29 31 27.5" stroke="#FFFFFF" strokeWidth="0.85" fill="none" opacity="0.9" />

        {/* Meridian grid vertical lines (curved perspective) */}
        <line x1="18" y1="18" x2="18" y2="33" stroke="#FFFFFF" strokeWidth="0.85" opacity="0.9" />
        <line x1="13.2" y1="18" x2="12.5" y2="33" stroke="#FFFFFF" strokeWidth="0.85" opacity="0.9" />
        <line x1="22.8" y1="18" x2="23.5" y2="33" stroke="#FFFFFF" strokeWidth="0.85" opacity="0.9" />
        <line x1="8.5" y1="18" x2="7.5" y2="33" stroke="#FFFFFF" strokeWidth="0.85" opacity="0.9" />
        <line x1="27.5" y1="18" x2="28.5" y2="33" stroke="#FFFFFF" strokeWidth="0.85" opacity="0.9" />
      </g>
    </svg>
  );
}
