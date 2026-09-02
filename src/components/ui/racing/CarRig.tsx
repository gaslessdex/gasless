import type { CSSProperties } from 'react';
import bodyLight from '../../../../assets/images/car/car-body-light.png';
import bodyDark from '../../../../assets/images/car/car-body-dark.png';
import wheel from '../../../../assets/images/car/car-wheel.png';
import type { Theme } from '../../../types/app';
import type { Feature } from '../../../types/app';
import { SteeringWheel } from './CockpitAnchor';
import { ActionHUD } from '../ActionHUD';

type CarPartLayout = { x: number; y: number; scale: number; rotation: number; zIndex: number; opacity: number };

const CAR_LAYOUT = {
  rig: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 12, opacity: 1, width: 800, bottom: -72 },
  body: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 2, opacity: 1 },
  leftWheel: { x: -323, y: 189, scale: 1.2, rotation: 0, zIndex: 1, opacity: 1 },
  rightWheel: { x: 323, y: 189, scale: 1.2, rotation: 0, zIndex: 1, opacity: 1 },
  steeringWheel: { x: 0, y: 89, scale: 0.8, rotation: 0, zIndex: 3, opacity: 1 },
} as const;

function partStyle(part: CarPartLayout): CSSProperties {
  const x = part.x / CAR_LAYOUT.rig.width * 100;
  const y = part.y / CAR_LAYOUT.rig.width * 100;
  return {
    '--car-left': `${50 + x}%`,
    '--car-bottom': `${y}%`,
    '--car-scale': part.scale,
    '--car-rotate': `${part.rotation}deg`,
    zIndex: part.zIndex,
    opacity: part.opacity,
  } as CSSProperties;
}

export function CarRig({ theme, activeAction, consoleOpen, onActionHover, onActionSelect, onFaqSelect, onMobileMenu }: {
  theme: Theme;
  activeAction: Feature | null;
  consoleOpen: boolean;
  onActionHover: (feature: Feature | null) => void;
  onActionSelect: (feature: Feature, trigger: HTMLButtonElement) => void;
  onFaqSelect: () => void;
  onMobileMenu: () => void;
}) {
  const rigStyle = {
    '--rig-width': `${CAR_LAYOUT.rig.width}px`,
    '--rig-x': `${CAR_LAYOUT.rig.x}px`,
    '--rig-y': `${CAR_LAYOUT.rig.y}px`,
    '--rig-bottom': `${CAR_LAYOUT.rig.bottom}px`,
    '--rig-scale': CAR_LAYOUT.rig.scale,
    '--rig-rotate': `${CAR_LAYOUT.rig.rotation}deg`,
    zIndex: CAR_LAYOUT.rig.zIndex,
    opacity: CAR_LAYOUT.rig.opacity,
  } as CSSProperties;

  return (
    <div className="car-rig" style={rigStyle} aria-label="Formula car cockpit">
      <div className="car-part car-wheel car-wheel--left" style={partStyle(CAR_LAYOUT.leftWheel)}>
        <div className="wheel-clip"><div className="wheel-steer"><div className="wheel-roll"><img src={wheel} alt="" draggable={false} /></div></div></div>
      </div>
      <div className="car-part car-wheel car-wheel--right" style={partStyle(CAR_LAYOUT.rightWheel)}>
        <div className="wheel-clip"><div className="wheel-steer"><div className="wheel-roll"><img src={wheel} alt="" draggable={false} /></div></div></div>
      </div>
      <div className="car-part car-body" style={partStyle(CAR_LAYOUT.body)}><img src={theme === 'light' ? bodyLight : bodyDark} alt="" draggable={false} /></div>
      <div className="car-part car-steering" style={partStyle(CAR_LAYOUT.steeringWheel)}>
        <ActionHUD active={activeAction} disabled={consoleOpen} onHover={onActionHover} onSelect={onActionSelect} />
        <SteeringWheel onFaqSelect={onFaqSelect} onMobileMenu={onMobileMenu} />
      </div>
    </div>
  );
}
