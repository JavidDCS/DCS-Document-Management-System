import { useId } from 'react';

/** Original inline SVG artwork in the brand palette (sun, solar panels, documents). No external assets. */

export function SunPanels({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 520 300" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-sun`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#FFE29A" />
          <stop offset=".55" stopColor="#F5A524" />
          <stop offset="1" stopColor="#F2703F" />
        </radialGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#F5A524" stopOpacity=".55" />
          <stop offset="1" stopColor="#F5A524" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-panel`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3C74C9" />
          <stop offset="1" stopColor="#14315C" />
        </linearGradient>
      </defs>
      <circle cx="330" cy="150" r="170" fill={`url(#${id}-glow)`} />
      <g className="animate-drift" style={{ transformOrigin: '330px 130px' }}>
        <circle cx="330" cy="130" r="64" fill={`url(#${id}-sun)`} />
        {[...Array(12)].map((_, i) => {
          const a = (i / 12) * Math.PI * 2;
          return <line key={i} x1={330 + Math.cos(a) * 80} y1={130 + Math.sin(a) * 80} x2={330 + Math.cos(a) * 98} y2={130 + Math.sin(a) * 98} stroke="#FFC450" strokeWidth="5" strokeLinecap="round" opacity=".85" />;
        })}
      </g>
      <path d="M0 232 C90 214 150 224 230 218 C320 210 400 226 520 214 L520 300 L0 300 Z" fill="#0A1830" opacity=".55" />
      {[0, 1, 2, 3].map((i) => (
        <g key={i} transform={`translate(${70 + i * 105} ${200 - (i % 2) * 6})`}>
          <path d="M8 0 H92 L104 52 H-4 Z" fill={`url(#${id}-panel)`} stroke="#7FA8E8" strokeOpacity=".55" strokeWidth="1.5" />
          <path d="M36 0 L30 52 M64 0 L70 52 M2 26 H100" stroke="#9CC0F5" strokeOpacity=".5" strokeWidth="1" />
          <path d="M52 52 V74 M36 74 H68" stroke="#7FA8E8" strokeOpacity=".6" strokeWidth="3" strokeLinecap="round" />
        </g>
      ))}
    </svg>
  );
}

export function DocShield({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 160 160" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFC450" />
          <stop offset="1" stopColor="#F2703F" />
        </linearGradient>
      </defs>
      <rect x="20" y="22" width="86" height="110" rx="10" fill="#fff" stroke="#DCE5F2" strokeWidth="2" transform="rotate(-6 63 77)" />
      <rect x="34" y="14" width="86" height="110" rx="10" fill="#fff" stroke="#DCE5F2" strokeWidth="2" />
      <path d="M50 40h54M50 54h54M50 68h38" stroke="#C3D0E4" strokeWidth="5" strokeLinecap="round" />
      <path d="M104 78 L132 88 V108 C132 124 120 134 104 140 C88 134 76 124 76 108 V88 Z" fill={`url(#${id}-g)`} />
      <path d="M92 108 l9 9 l16 -18" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PaperPlane({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 160 160" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5FB0FF" />
          <stop offset="1" stopColor="#2F6FE0" />
        </linearGradient>
      </defs>
      <path d="M10 120 C40 110 70 118 150 100" stroke="#DCE5F2" strokeWidth="3" strokeDasharray="4 8" strokeLinecap="round" />
      <path d="M26 74 L138 28 L108 128 L74 98 Z" fill={`url(#${id}-g)`} />
      <path d="M74 98 L138 28 L58 84 Z" fill="#fff" opacity=".35" />
      <path d="M74 98 V126 L92 108" fill="#1F4FB5" />
    </svg>
  );
}

export function EmptyFolder({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 160 160" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFD58A" />
          <stop offset="1" stopColor="#F5A524" />
        </linearGradient>
      </defs>
      <path d="M18 52 a8 8 0 0 1 8 -8 h32 l12 14 h64 a8 8 0 0 1 8 8 v58 a8 8 0 0 1 -8 8 H26 a8 8 0 0 1 -8 -8 Z" fill={`url(#${id}-g)`} />
      <path d="M18 70 H142 V122 a8 8 0 0 1 -8 8 H26 a8 8 0 0 1 -8 -8 Z" fill="#FFE9BD" />
      <path d="M62 98 h36" stroke="#F5A524" strokeWidth="5" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

export function Magnifier({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 160 160" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFC450" />
          <stop offset="1" stopColor="#F2703F" />
        </linearGradient>
      </defs>
      <circle cx="70" cy="68" r="38" fill="#EAF2FF" stroke="#9CC0F5" strokeWidth="6" />
      <path d="M52 62 a22 22 0 0 1 22 -20" stroke="#fff" strokeWidth="6" strokeLinecap="round" opacity=".9" />
      <path d="M98 96 L132 130" stroke={`url(#${id}-g)`} strokeWidth="14" strokeLinecap="round" />
    </svg>
  );
}

export function InboxArt({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 160 160" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7BE0B6" />
          <stop offset="1" stopColor="#0B8F63" />
        </linearGradient>
      </defs>
      <rect x="18" y="40" width="124" height="84" rx="12" fill="#fff" stroke="#DCE5F2" strokeWidth="2" />
      <path d="M22 48 L80 92 L138 48" stroke="#9CC0F5" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="124" cy="46" r="18" fill={`url(#${id}-g)`} />
      <path d="M116 46 l6 6 l10 -12" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export type Art = 'folder' | 'search' | 'send' | 'shield' | 'inbox';
export function ArtFor({ art, className }: { art: Art; className?: string }) {
  switch (art) {
    case 'search': return <Magnifier className={className} />;
    case 'send': return <PaperPlane className={className} />;
    case 'shield': return <DocShield className={className} />;
    case 'inbox': return <InboxArt className={className} />;
    default: return <EmptyFolder className={className} />;
  }
}

/** Deterministic gradient for avatars and type badges from a string. */
export function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue} 78% 62%), hsl(${(hue + 40) % 360} 70% 46%))`;
}
