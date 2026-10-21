import { POOL_LABELS, poolLabel, type FlowStage, type VerdictLeg } from '../utils/types';

interface RouteVisualizerProps {
  stage: FlowStage;
  /** Route to draw; when empty the three known pools are shown idle. */
  route: VerdictLeg[] | null;
}

const W = 880;
const H = 300;

export function RouteVisualizer({ stage, route }: RouteVisualizerProps) {
  const deposited = stage !== 'idle' && stage !== 'depositing';
  const consensus = stage === 'adjudicating';
  const settling = stage === 'settling';
  const settled = stage === 'executed';

  const pools: VerdictLeg[] =
    route && route.length > 0
      ? route
      : Object.keys(POOL_LABELS).map((target_pool) => ({ target_pool, percentage: 0, eco_score: '' }));
  const poolY = (i: number) => (pools.length === 1 ? H / 2 : 56 + (i * (H - 112)) / (pools.length - 1));

  const edge = (x1: number, y1: number, x2: number, y2: number, on: boolean, key: string) => {
    const mx = (x1 + x2) / 2;
    return (
      <path
        key={key}
        d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
        fill="none"
        stroke={on ? 'var(--accent)' : 'var(--line-2)'}
        strokeWidth={on ? 2 : 1.5}
        className={on ? 'edge-active' : undefined}
      />
    );
  };

  const node = (x: number, label: string, sub: string, active: boolean) => (
    <g key={label}>
      <rect x={x - 62} y={H / 2 - 30} width={124} height={60} rx={12} fill="var(--surface)" stroke={active ? 'var(--accent)' : 'var(--line-2)'} strokeWidth={active ? 2 : 1.5} />
      <text x={x} y={H / 2 - 4} textAnchor="middle" fill="var(--fg)" fontSize="14" fontWeight="600">
        {label}
      </text>
      <text x={x} y={H / 2 + 14} textAnchor="middle" fill="var(--subtle)" fontSize="11">
        {sub}
      </text>
    </g>
  );

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Flow from your wallet to the vault, GenLayer consensus and the pools">
        {edge(132, H / 2, 218, H / 2, deposited, 'e1')}
        {edge(342, H / 2, 438, H / 2, consensus || settling || settled, 'e2')}
        {pools.map((p, i) => edge(562, H / 2, 722, poolY(i), settled && p.percentage > 0, `p-${p.target_pool}`))}

        {node(70, 'Wallet', 'Signs deposit', stage === 'depositing')}
        {node(280, 'Vault', 'Escrow on Portaldot', deposited)}
        {node(500, 'GenLayer', 'Validator consensus', consensus)}

        {pools.map((p, i) => {
          const on = settled && p.percentage > 0;
          return (
            <g key={p.target_pool}>
              <rect x={722} y={poolY(i) - 24} width={150} height={48} rx={10} fill="var(--surface)" stroke={on ? 'var(--accent)' : 'var(--line-2)'} strokeWidth={on ? 2 : 1.5} />
              <text x={738} y={poolY(i) - 3} fill={on ? 'var(--fg)' : 'var(--muted)'} fontSize="13" fontWeight="600">
                {poolLabel(p.target_pool)}
              </text>
              <text x={738} y={poolY(i) + 14} fill="var(--subtle)" fontSize="11">
                {p.percentage > 0 ? `${p.percentage}%${p.eco_score ? ` · ${p.eco_score}` : ''}` : 'Whitelisted'}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
