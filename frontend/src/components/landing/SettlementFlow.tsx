import type { ReactNode } from 'react';

export interface FlowMeta {
  hash: string;
  id: string;
  route: string;
  network: string;
  settledIn: string;
}

/** Surfaces an intent can arrive through. These are the integration points the repository actually ships. */
const SOURCES: Array<{ y: number; h: number; label: string; sub?: string; icon: ReactNode }> = [
  {
    y: 56,
    h: 38,
    label: 'User intent',
    sub: 'Plain-language prompt',
    icon: (
      <g fill="none" stroke="#a0b0bf" strokeWidth="1.2">
        <circle r="5" />
        <circle r="1.6" fill="#a0b0bf" />
      </g>
    ),
  },
  {
    y: 101,
    h: 25,
    label: 'dApp',
    icon: (
      <g fill="none" stroke="#a0b0bf" strokeWidth="1.2">
        <rect x="-5.5" y="-4.5" width="11" height="9" rx="1.2" />
        <path d="M-5.5 -1.5H5.5" />
      </g>
    ),
  },
  {
    y: 134,
    h: 25,
    label: 'SDK',
    icon: <path d="M-2.5 -4L-6 0l3.5 4M2.5 -4L6 0l-3.5 4" fill="none" stroke="#a0b0bf" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />,
  },
  {
    y: 167,
    h: 25,
    label: 'Embeddable widget',
    icon: (
      <g fill="none" stroke="#a0b0bf" strokeWidth="1.1">
        <rect x="-5.5" y="-5.5" width="4.5" height="4.5" rx="0.8" />
        <rect x="1" y="-5.5" width="4.5" height="4.5" rx="0.8" />
        <rect x="-5.5" y="1" width="4.5" height="4.5" rx="0.8" />
        <rect x="1" y="1" width="4.5" height="4.5" rx="0.8" />
      </g>
    ),
  },
  {
    y: 200,
    h: 25,
    label: 'CLI',
    icon: <path d="M-5 -3.5L-1 0l-4 3.5M0.5 4H5.5" fill="none" stroke="#a0b0bf" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />,
  },
];

const TARGET_Y = [140, 147, 154, 161, 168];

/** A hexagon outline of radius r centred on the origin. */
const hex = (r: number): string =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    return `${i === 0 ? 'M' : 'L'}${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  }).join(' ') + 'Z';

export function SettlementFlow({ meta }: { meta: FlowMeta }) {
  const fields: Array<[string, string]> = [
    ['Transaction hash', meta.hash],
    ['Intent ID', meta.id],
    ['Route', meta.route],
    ['Network', meta.network],
    ['Settled in', meta.settledIn],
  ];

  return (
    <div className="kt-flow">
      <svg viewBox="0 0 774 263" role="img" aria-labelledby="flow-title flow-desc" preserveAspectRatio="xMidYMid meet">
        <title id="flow-title">Live settlement flow</title>
        <desc id="flow-desc">
          An intent arrives from a dApp, SDK, widget or CLI, is routed by Katalyst&apos;s validator-consensus engine, and settles onchain with a verifiable outcome.
        </desc>
        <defs>
          <pattern id="kt-grid" width="22" height="22" patternUnits="userSpaceOnUse">
            <path d="M22 0H0V22" fill="none" stroke="rgba(105,145,163,0.07)" strokeWidth="1" />
          </pattern>
          <linearGradient id="kt-bundle" x1="409" y1="0" x2="476" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#248dff" />
            <stop offset="0.55" stopColor="#35caff" />
            <stop offset="1" stopColor="#c4ff42" />
          </linearGradient>
          <linearGradient id="kt-in" x1="164" y1="0" x2="302" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#35caff" stopOpacity="0.15" />
            <stop offset="1" stopColor="#248dff" stopOpacity="0.95" />
          </linearGradient>
          <filter id="kt-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        <rect width="774" height="263" fill="url(#kt-grid)" />
        <text x="17" y="24" fill="#7f95ad" fontSize="8.5" fontWeight="600" letterSpacing="1.6">
          LIVE SETTLEMENT FLOW
        </text>

        {/* stage labels */}
        {[
          [209, 'RECEIVED', '#c4ff42'],
          [392, 'ROUTED', '#248dff'],
          [581, 'SETTLED', '#42e58b'],
        ].map(([x, label, color]) => (
          <g key={String(label)}>
            <circle cx={Number(x)} cy={44} r="3" fill={String(color)} />
            <text x={Number(x) + 10} y={47} fill="#a0b0bf" fontSize="8" fontWeight="600" letterSpacing="1.2">
              {label}
            </text>
          </g>
        ))}

        {/* sources -> routing engine */}
        {SOURCES.map((s, i) => {
          const y = s.y + s.h / 2;
          const d = `M164 ${y} C 236 ${y}, 236 ${TARGET_Y[i]}, 302 ${TARGET_Y[i]}`;
          return (
            <g key={s.label}>
              <path d={d} fill="none" stroke="url(#kt-in)" strokeWidth="1.1" />
              <path d={d} className="travel" fill="none" stroke="#35caff" strokeOpacity="0.8" strokeWidth="1.3" strokeLinecap="round" />
            </g>
          );
        })}

        {/* routing engine -> verification: a converging bundle */}
        {Array.from({ length: 9 }, (_, i) => {
          const y = 138 + i * 3.5;
          const y2 = 152 + (y - 152) * 0.55;
          const d = `M409 ${y} C 436 ${y}, 450 ${y2}, 476 ${y2}`;
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="url(#kt-bundle)" strokeWidth="1" strokeOpacity="0.9" />
              {i % 2 === 0 && <path d={d} className="travel" fill="none" stroke="#e9ffb5" strokeOpacity="0.7" strokeWidth="1.1" strokeLinecap="round" />}
            </g>
          );
        })}
        <path d="M588 152H640" stroke="#42e58b" strokeOpacity="0.5" strokeWidth="1" strokeDasharray="1 3" />

        {/* sources */}
        {SOURCES.map((s) => (
          <g key={s.label}>
            <rect x="17" y={s.y} width="147" height={s.h} rx="3" fill="#080e12" stroke="#22323b" />
            <g transform={`translate(32 ${s.y + s.h / 2 - (s.sub ? 5 : 0)})`}>{s.icon}</g>
            <text x="46" y={s.y + s.h / 2 + (s.sub ? -3 : 3.2)} fill="#e6ecf1" fontSize="8.8" fontWeight="500">
              {s.label}
            </text>
            {s.sub && (
              <text x="46" y={s.y + s.h / 2 + 9} fill="#65798b" fontSize="7.2">
                {s.sub}
              </text>
            )}
          </g>
        ))}

        {/* routing engine */}
        <rect x="302" y="96" width="107" height="116" rx="4" fill="none" stroke="#248dff" strokeOpacity="0.55" strokeWidth="2" filter="url(#kt-glow)" />
        <rect x="302" y="96" width="107" height="116" rx="4" fill="rgba(36,141,255,0.06)" stroke="#248dff" strokeWidth="1.2" />
        <g transform="translate(355.5 128)" fill="none" stroke="#35caff" strokeWidth="1.3" strokeLinejoin="round">
          <path d={hex(15)} />
          <path d={hex(8)} stroke="#248dff" />
          <circle r="2" fill="#35caff" stroke="none" />
        </g>
        <text x="355.5" y="165" textAnchor="middle" fill="#f3f6f8" fontSize="9.5" fontWeight="600">
          Katalyst
        </text>
        <text x="355.5" y="177" textAnchor="middle" fill="#f3f6f8" fontSize="9.5" fontWeight="600">
          Routing Engine
        </text>
        <text x="355.5" y="193" textAnchor="middle" fill="#6aa8e6" fontSize="6.8">
          Validator consensus
        </text>
        <text x="355.5" y="203" textAnchor="middle" fill="#6aa8e6" fontSize="6.8">
          Deterministic allocation
        </text>

        {/* settlement verified */}
        <rect x="476" y="89" width="112" height="123" rx="4" fill="none" stroke="#a9ed36" strokeOpacity="0.45" strokeWidth="2" filter="url(#kt-glow)" />
        <rect x="476" y="89" width="112" height="123" rx="4" fill="rgba(66,229,139,0.05)" stroke="#a9ed36" strokeWidth="1.2" />
        <g transform="translate(532 126)" fill="none" stroke="#42e58b" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round">
          <path d={hex(17)} />
          <path d="M-9 -4.6L0 0.5l9-5.1M0 0.5V10" stroke="#42e58b" strokeOpacity="0.55" />
          <path d="M-5 1l3.5 3.5L6 -3" stroke="#c4ff42" strokeWidth="1.6" />
        </g>
        <text x="532" y="170" textAnchor="middle" fill="#e9ffd0" fontSize="9.5" fontWeight="600">
          Settlement verified
        </text>
        <text x="532" y="185" textAnchor="middle" fill="#7fc79c" fontSize="6.8">
          Onchain settlement
        </text>
        <text x="532" y="195" textAnchor="middle" fill="#7fc79c" fontSize="6.8">
          Independently verifiable
        </text>

        {/* metadata */}
        <rect x="640" y="67" width="123" height="183" rx="3" fill="#080e12" stroke="#22323b" />
        {fields.map(([label, value], i) => (
          <g key={label}>
            <text x="651" y={86 + i * 32} fill="#65798b" fontSize="6.6" letterSpacing="0.3">
              {label}
            </text>
            <text x="651" y={97.5 + i * 32} className="m" fill="#dfe7ee" fontSize="7.8">
              {value}
            </text>
            {i < fields.length - 1 && <path d={`M651 ${104 + i * 32}H752`} stroke="#16232b" />}
          </g>
        ))}
      </svg>
    </div>
  );
}
