import { useRef } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { Feature } from '../../types/app';

type ActionDefinition = {
  id: Feature;
  label: string;
  accessibleLabel: string;
  startAngle: number;
  endAngle: number;
  outwardX: number;
  outwardY: number;
};

const CENTER = 360;
const INNER_RADIUS = 184;
const OUTER_RADIUS = 316;

const ACTIONS: ActionDefinition[] = [
  { id: 'claim', label: 'CLEAN', accessibleLabel: 'Open Clean tools.', startAngle: 92, endAngle: 208, outwardX: -0.866, outwardY: 0.5 },
  { id: 'swap', label: 'SWAP', accessibleLabel: 'Swap supported tokens without SOL.', startAngle: -148, endAngle: -32, outwardX: 0, outwardY: -1 },
  { id: 'send', label: 'SEND', accessibleLabel: 'Send supported tokens without SOL.', startAngle: -28, endAngle: 88, outwardX: 0.866, outwardY: 0.5 },
];

const LABEL_PATHS: Record<Feature, string> = {
  claim: 'M 150 482 A 270 270 0 0 1 92 250',
  swap: 'M 155 190 A 270 270 0 0 1 565 190',
  send: 'M 628 250 A 270 270 0 0 1 570 482',
};

function point(radius: number, angle: number) {
  const radians = angle * Math.PI / 180;
  return { x: CENTER + Math.cos(radians) * radius, y: CENTER + Math.sin(radians) * radius };
}

function sectorPath(innerRadius: number, outerRadius: number, startAngle: number, endAngle: number) {
  const outerStart = point(outerRadius, startAngle);
  const outerEnd = point(outerRadius, endAngle);
  const innerEnd = point(innerRadius, endAngle);
  const innerStart = point(innerRadius, startAngle);
  return `M ${outerStart.x} ${outerStart.y} A ${outerRadius} ${outerRadius} 0 0 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 0 0 ${innerStart.x} ${innerStart.y} Z`;
}

export function ActionHUD({ active, disabled, onHover, onSelect }: {
  active: Feature | null;
  disabled?: boolean;
  onHover: (feature: Feature | null) => void;
  onSelect: (feature: Feature, trigger: HTMLButtonElement) => void;
}) {
  const pressed = useRef<Feature | null>(null);
  const buttons = useRef<Record<Feature, HTMLButtonElement | null>>({ claim: null, swap: null, send: null });

  const activate = (action: ActionDefinition, trigger?: HTMLButtonElement | null) => {
    if (!disabled && trigger) onSelect(action.id, trigger);
  };

  return (
    <section className="action-hud" aria-label="GASLESS actions">
      <svg viewBox="0 0 720 720" aria-hidden="true">
        <defs>{ACTIONS.map((action) => <path key={action.id} id={`action-label-path-${action.id}`} d={LABEL_PATHS[action.id]} />)}</defs>
        <circle className="action-dead-zone" cx={CENTER} cy={CENTER} r={INNER_RADIUS - 8} aria-hidden="true" />
        {ACTIONS.map((action) => {
          const style = { '--out-x': action.outwardX, '--out-y': action.outwardY } as CSSProperties;
          return (
            <g
              key={action.id}
              className={`action-segment action-${action.id}${active === action.id ? ' is-active' : ''}${active && active !== action.id ? ' is-muted' : ''}`}
              style={style}
              onPointerEnter={(event) => { if (event.pointerType === 'mouse') onHover(action.id); }}
              onPointerLeave={(event) => { if (event.pointerType === 'mouse') onHover(null); pressed.current = null; }}
              onPointerDown={(event: PointerEvent<SVGGElement>) => { pressed.current = action.id; event.currentTarget.classList.add('is-pressed'); }}
              onPointerUp={(event) => { event.currentTarget.classList.remove('is-pressed'); pressed.current = null; }}
              onPointerCancel={(event) => { event.currentTarget.classList.remove('is-pressed'); pressed.current = null; }}
              onClick={() => activate(action, buttons.current[action.id])}
            >
              <path className="action-hit" d={sectorPath(INNER_RADIUS - 10, OUTER_RADIUS + 12, action.startAngle, action.endAngle)} />
              <path className="action-plane" d={sectorPath(INNER_RADIUS, OUTER_RADIUS, action.startAngle, action.endAngle)} aria-hidden="true" />
              <path className="action-edge" d={sectorPath(OUTER_RADIUS - 3, OUTER_RADIUS, action.startAngle, action.endAngle)} aria-hidden="true" />
              <text className="action-label" aria-hidden="true"><textPath href={`#action-label-path-${action.id}`} startOffset="50%" textAnchor="middle">{action.label}</textPath></text>
            </g>
          );
        })}
      </svg>
      {ACTIONS.map((action) => <button
        key={action.id}
        ref={(node) => { buttons.current[action.id] = node; }}
        id={`action-trigger-${action.id}`}
        className={`action-keyboard-control action-keyboard-${action.id}${active === action.id ? ' is-active' : ''}`}
        type="button"
        disabled={disabled}
        aria-label={action.accessibleLabel}
        onPointerEnter={(event) => { if (event.pointerType === 'mouse') onHover(action.id); }}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') onHover(null); }}
        onFocus={() => onHover(action.id)}
        onBlur={() => onHover(null)}
        onClick={(event) => activate(action, event.currentTarget)}
      >{action.label}</button>)}
    </section>
  );
}
