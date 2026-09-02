import { useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { CatmullRomCurve3, Vector3, type Group } from 'three';
import type { Theme } from '../../../types/app';
import { sceneVelocity } from './sceneMotion';

type Side = -1 | 1;
type Zone = 'far' | 'mid' | 'near';
type PieceKind = 'building' | 'house' | 'tree' | 'lamp' | 'sign' | 'billboard' | 'bush' | 'barrier';
type Piece = { kind: PieceKind; side: Side; x: number; z: number; variant: number; scale: number };

const palette = (theme: Theme, zone: Zone) => {
  const dark = theme === 'dark';
  if (zone === 'far') return { body: dark ? '#25282b' : '#c4c4bf', trim: dark ? '#34383b' : '#aaa9a4', detail: dark ? '#55595c' : '#8e8e89' };
  if (zone === 'mid') return { body: dark ? '#34373b' : '#8c8c88', trim: dark ? '#666a6d' : '#686864', detail: dark ? '#9da0a2' : '#474744' };
  return { body: dark ? '#5d6164' : '#3a3a3a', trim: dark ? '#b7babd' : '#202020', detail: dark ? '#ecece7' : '#080808' };
};

function Material({ color, metal = 0.08 }: { color: string; metal?: number }) {
  return <meshStandardMaterial color={color} roughness={metal > 0.4 ? 0.38 : 0.82} metalness={metal} />;
}

function Building({ theme, zone, variant }: { theme: Theme; zone: Zone; variant: number }) {
  const p = palette(theme, zone);
  const width = [3.1, 4.2, 3.5, 5, 3.7, 4.4][variant % 6];
  const height = [7.5, 11, 8.8, 13, 9.8, 12][variant % 6];
  const depth = [3, 3.8, 4.2, 3.3, 4.6, 3.7][variant % 6];
  const rows = zone === 'far' ? 3 : Math.min(6, 3 + (variant % 4));
  const windowColor = theme === 'dark' ? (zone === 'far' ? '#45494b' : '#b5b7b5') : p.detail;
  return (
    <group>
      <mesh position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><Material color={p.body} /></mesh>
      {Array.from({ length: rows }, (_, row) => (
        <group key={row} position={[0, 1.2 + row * ((height - 1.8) / rows), depth / 2 + 0.025]}>
          {Array.from({ length: 2 + (variant % 3) }, (__, column) => (
            <mesh key={column} position={[(column - (1 + variant % 3) / 2 + .5) * (width / (3 + variant % 3)), 0, 0]}>
              <planeGeometry args={[width / (4.5 + variant % 3), .42]} />
              <meshBasicMaterial color={windowColor} />
            </mesh>
          ))}
        </group>
      ))}
      {(variant === 1 || variant === 4) && Array.from({ length: 4 }, (_, band) => (
        <mesh key={band} position={[0, 2 + band * 2, depth / 2 + .06]}><boxGeometry args={[width + .16, .1, .12]} /><Material color={p.trim} metal={.45} /></mesh>
      ))}
      <mesh position={[0, height + .16, 0]}><boxGeometry args={[width + .22, .32, depth + .22]} /><Material color={p.trim} metal={.28} /></mesh>
      {variant % 3 === 0 && <mesh position={[width * .2, height + .72, 0]}><boxGeometry args={[width * .3, 1.1, depth * .35]} /><Material color={p.body} /></mesh>}
      {variant === 5 && <mesh position={[-width * .22, height + 1.4, 0]}><cylinderGeometry args={[.05, .07, 2.5, 8]} /><Material color={p.detail} metal={.7} /></mesh>}
    </group>
  );
}

function House({ theme, zone, variant }: { theme: Theme; zone: Zone; variant: number }) {
  const p = palette(theme, zone);
  const width = 4.3 + (variant % 2) * .8;
  const height = 3.4 + (variant % 3) * .35;
  const depth = 4.2;
  const face = theme === 'dark' ? '#b5b7b5' : p.detail;
  return <group>
    <mesh position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><Material color={p.body} /></mesh>
    <mesh position={[-width * .24, height + .72, 0]} rotation={[0, 0, .52]}><boxGeometry args={[width * .62, .18, depth + .28]} /><Material color={p.trim} metal={.22} /></mesh>
    <mesh position={[width * .24, height + .72, 0]} rotation={[0, 0, -.52]}><boxGeometry args={[width * .62, .18, depth + .28]} /><Material color={p.trim} metal={.22} /></mesh>
    {[-1, 1].map(x => <mesh key={x} position={[x * width * .24, 2.05, depth / 2 + .03]}><planeGeometry args={[.72, .82]} /><meshBasicMaterial color={face} /></mesh>)}
    <mesh position={[0, .92, depth / 2 + .05]}><planeGeometry args={[.68, 1.7]} /><meshBasicMaterial color={p.trim} /></mesh>
    {variant % 2 === 0 && <mesh position={[width * .28, height + 1.5, .7]}><boxGeometry args={[.46, 1.75, .56]} /><Material color={p.body} /></mesh>}
  </group>;
}

function Tree({ theme, zone, variant }: { theme: Theme; zone: Zone; variant: number }) {
  const p = palette(theme, zone);
  const trunk = theme === 'dark' ? '#626562' : '#666661';
  if (variant % 3 === 0) return (
    <group><mesh position={[0, 2.1, 0]}><cylinderGeometry args={[.18, .3, 4.2, 8]} /><Material color={trunk} /></mesh>
      {[1.9, 3.1, 4.25, 5.25].map((y, i) => <mesh key={y} position={[0, y, 0]}><coneGeometry args={[1.55 - i * .2, 2.6, 9]} /><Material color={p.body} /></mesh>)}</group>
  );
  if (variant % 3 === 1) return (
    <group><mesh position={[0, 2.15, 0]}><cylinderGeometry args={[.2, .34, 4.3, 8]} /><Material color={trunk} /></mesh>
      {[[-.65, 4.4, .2, 1.25], [.55, 4.65, 0, 1.45], [0, 5.65, -.15, 1.55]].map(([x, y, z, s], i) => <mesh key={i} position={[x, y, z]} scale={[s, s * .8, s]}><dodecahedronGeometry args={[1, 0]} /><Material color={i === 2 ? p.trim : p.body} /></mesh>)}</group>
  );
  return (
    <group><mesh position={[0, 2.3, 0]}><cylinderGeometry args={[.16, .28, 4.6, 7]} /><Material color={trunk} /></mesh>
      <mesh position={[-.45, 3.5, 0]} rotation={[0, 0, -.6]}><cylinderGeometry args={[.08, .14, 1.9, 7]} /><Material color={trunk} /></mesh>
      {[[-.7, 4.5, 0], [.65, 4.9, 0], [.1, 5.7, 0]].map((v, i) => <mesh key={i} position={v as [number, number, number]} scale={[1.1, .65, .8]}><icosahedronGeometry args={[1.15, 0]} /><Material color={p.body} /></mesh>)}</group>
  );
}

function Lamp({ theme, side }: { theme: Theme; side: Side }) {
  const p = palette(theme, 'near');
  return <group><mesh position={[0, 3, 0]}><cylinderGeometry args={[.055, .11, 6, 8]} /><Material color={p.trim} metal={.75} /></mesh>
    <mesh position={[-side * .62, 5.85, 0]} rotation={[0, 0, side * 1.17]}><boxGeometry args={[1.35, .08, .09]} /><Material color={p.trim} metal={.75} /></mesh>
    <mesh position={[-side * 1.05, 6.18, 0]}><boxGeometry args={[.48, .14, .3]} /><meshBasicMaterial color={theme === 'dark' ? '#f2f2eb' : '#5d5d58'} /></mesh></group>;
}

function Bush({ theme, variant }: { theme: Theme; variant: number }) {
  const p = palette(theme, 'near');
  return <group>{[-.7, 0, .68].map((x, i) => <mesh key={x} position={[x, .5 + (i % 2) * .12, 0]} scale={[1, .65, .72]}><dodecahedronGeometry args={[.85 + ((variant + i) % 2) * .15, 0]} /><Material color={i === 1 ? p.trim : p.body} /></mesh>)}</group>;
}

function Barrier({ theme }: { theme: Theme }) {
  const p = palette(theme, 'near');
  return <group><mesh position={[0, .72, 0]}><boxGeometry args={[.16, .22, 5.4]} /><Material color={p.trim} metal={.7} /></mesh>
    {[-2.3, 0, 2.3].map(z => <mesh key={z} position={[0, .35, z]}><boxGeometry args={[.12, .85, .12]} /><Material color={p.trim} metal={.65} /></mesh>)}</group>;
}

function Sign({ theme, side, billboard = false }: { theme: Theme; side: Side; billboard?: boolean }) {
  const p = palette(theme, 'mid');
  return <group><mesh position={[0, billboard ? 2.8 : 1.7, 0]}><boxGeometry args={[.12, billboard ? 5.6 : 3.4, .12]} /><Material color={p.trim} metal={.65} /></mesh>
    {billboard && <mesh position={[side * 2.2, 2.8, 0]}><boxGeometry args={[.12, 5.6, .12]} /><Material color={p.trim} metal={.65} /></mesh>}
    <mesh position={[side * (billboard ? 1.1 : 0), billboard ? 5.15 : 3.25, 0]}><boxGeometry args={[billboard ? 4.7 : 1.8, billboard ? 1.8 : 1.2, .16]} /><Material color={p.body} metal={.25} /></mesh>
    <mesh position={[side * (billboard ? 1.1 : 0), billboard ? 5.15 : 3.25, -.1]}><boxGeometry args={[billboard ? 3.8 : 1.2, .08, .04]} /><meshBasicMaterial color={p.detail} /></mesh></group>;
}

function PieceAsset({ piece, theme, zone }: { piece: Piece; theme: Theme; zone: Zone }) {
  let asset: ReactNode;
  if (piece.kind === 'building') asset = <Building theme={theme} zone={zone} variant={piece.variant} />;
  else if (piece.kind === 'house') asset = <House theme={theme} zone={zone} variant={piece.variant} />;
  else if (piece.kind === 'tree') asset = <Tree theme={theme} zone={zone} variant={piece.variant} />;
  else if (piece.kind === 'lamp') asset = <Lamp theme={theme} side={piece.side} />;
  else if (piece.kind === 'sign' || piece.kind === 'billboard') asset = <Sign theme={theme} side={piece.side} billboard={piece.kind === 'billboard'} />;
  else if (piece.kind === 'bush') asset = <Bush theme={theme} variant={piece.variant} />;
  else asset = <Barrier theme={theme} />;
  const architectureScale = zone === 'near' && (piece.kind === 'building' || piece.kind === 'house') ? .92 : 1;
  const rightRoadClearance = zone === 'near' && piece.side > 0 && (piece.kind === 'building' || piece.kind === 'house') ? 2.2 : 0;
  return <group position={[piece.x + rightRoadClearance, -1.72, piece.z]} scale={piece.scale * architectureScale} rotation={[0, piece.side * (.03 + piece.variant * .006), 0]}>{asset}</group>;
}

function Pole({ theme, side, z = 0 }: { theme: Theme; side: Side; z?: number }) {
  const p = palette(theme, 'near');
  return <group position={[0, 0, z]}><mesh position={[0, 3.25, 0]}><cylinderGeometry args={[.08, .15, 6.5, 8]} /><Material color={p.trim} metal={.72} /></mesh>
    <mesh position={[-side * .48, 5.75, 0]}><boxGeometry args={[1.3, .1, .12]} /><Material color={p.trim} metal={.72} /></mesh>
    {[-.42, .42].map(x => <mesh key={x} position={[-side * .48 + x, 5.53, 0]}><cylinderGeometry args={[.035, .035, .42, 7]} /><Material color={p.detail} metal={.55} /></mesh>)}</group>;
}

function Cable({ theme, x, y, sag }: { theme: Theme; x: number; y: number; sag: number }) {
  const curve = useMemo(() => new CatmullRomCurve3([new Vector3(x, y, 0), new Vector3(x, y - sag, -6), new Vector3(x, y, -12)]), [x, y, sag]);
  return <mesh><tubeGeometry args={[curve, 12, .018, 5, false]} /><meshBasicMaterial color={theme === 'dark' ? '#777b7d' : '#555550'} /></mesh>;
}

function UtilityCell({ theme, side }: { theme: Theme; side: Side }) {
  return <group><Pole theme={theme} side={side} /><Cable theme={theme} x={-.9 * side} y={5.54} sag={.42} /><Cable theme={theme} x={-.08 * side} y={5.54} sag={.34} /></group>;
}

function Skyline({ theme }: { theme: Theme }) {
  const p = palette(theme, 'far');
  return <group position={[0, -1.72, -104]}>{Array.from({ length: 20 }, (_, i) => {
    const side = (i % 2 ? 1 : -1) as Side;
    const x = side * (7 + Math.floor(i / 2) * 3.4);
    const h = 7 + ((i * 11) % 13);
    return <group key={i} position={[x, 0, -((i * 7) % 18)]}><mesh position={[0, h / 2, 0]}><boxGeometry args={[3 + (i % 4), h, 3]} /><Material color={p.body} /></mesh>
      {i % 4 === 0 && <mesh position={[0, h + 1.2, 0]}><boxGeometry args={[.18, 2.4, .18]} /><Material color={p.trim} metal={.4} /></mesh>}</group>;
  })}</group>;
}

const makePieces = (slots: number, spacing: number, zone: Zone, baseOverride?: number, architectureOnly = false): Piece[] => Array.from({ length: slots }, (_, slot) => ([-1, 1] as Side[]).map((side) => {
  const patterns: Record<Zone, PieceKind[]> = {
    far: ['building', 'building', 'house', 'building', 'tree', 'building', 'house', 'building'],
    mid: ['building', 'tree', 'house', 'building', 'lamp', 'building', 'sign', 'house', 'building', 'billboard'],
    near: ['barrier', 'bush', 'house', 'tree', 'building', 'lamp', 'barrier', 'bush', 'house', 'sign', 'building', 'tree'],
  };
  const base = baseOverride ?? (zone === 'far' ? 15.3 : zone === 'mid' ? 10.2 : 7.9);
  const subtleRightVariation = side > 0 && slot % 5 === 0 ? 1 : 0;
  const kind = architectureOnly ? (slot % 5 === 2 ? 'house' : 'building') : patterns[zone][(slot * 3 + subtleRightVariation) % patterns[zone].length];
  const variantOffset = side > 0 && slot % 4 === 1 ? 1 : 0;
  return { kind, side, x: side * (base + ((slot * 7) % 4) * .58 + (side > 0 ? .24 : 0)), z: -18 - slot * spacing - (side > 0 ? spacing * .12 : 0), variant: (slot * 5 + variantOffset) % 6, scale: zone === 'far' ? .82 : zone === 'mid' ? .94 : 1 };
})).flat();

function movePool(group: Group | null, distance: number, wrap: number) {
  if (!group || distance === 0) return;
  for (const child of group.children) {
    child.position.z += distance;
    if (child.position.z > 17) child.position.z -= wrap;
  }
}

export function EnvironmentLoop({ theme, steering, slowed, reducedMotion }: { theme: Theme; steering: MutableRefObject<number>; slowed: boolean; reducedMotion: boolean }) {
  const skyline = useRef<Group>(null); const outer = useRef<Group>(null); const far = useRef<Group>(null); const mid = useRef<Group>(null); const near = useRef<Group>(null); const utilities = useRef<Group>(null);
  const mobile = useThree(state => state.size.width < 620);
  const outerPieces = useMemo(() => makePieces(24, 6.4, 'far', 20.5, true), []);
  const farPieces = useMemo(() => makePieces(26, 5.8, 'far'), []);
  const midPieces = useMemo(() => makePieces(28, 6.1, 'mid'), []);
  const nearPieces = useMemo(() => makePieces(30, 5.1, 'near'), []);
  const poleCount = mobile ? 10 : 16;

  useFrame((_, delta) => {
    const distance = sceneVelocity(slowed, reducedMotion) * Math.min(delta, .04);
    movePool(outer.current, distance * .5, 24 * 6.4);
    movePool(far.current, distance * .62, 26 * 5.8);
    movePool(mid.current, distance * .84, 28 * 6.1);
    movePool(near.current, distance, 30 * 5.1);
    movePool(utilities.current, distance, poleCount * 12);
    const steer = steering.current;
    const offsetLayer = (group: Group | null, multiplier: number, damping: number) => {
      if (group) group.position.x += (-steer * multiplier - group.position.x) * damping;
    };
    offsetLayer(skyline.current, .32, .035);
    offsetLayer(outer.current, .62, .04);
    offsetLayer(far.current, 1.05, .045);
    offsetLayer(mid.current, 1.9, .055);
    offsetLayer(near.current, 3.05, .07);
    offsetLayer(utilities.current, 3.45, .075);
  });

  const outerVisible = mobile ? outerPieces.filter((_, i) => Math.floor(i / 2) % 2 === 0) : outerPieces;
  const farVisible = mobile ? farPieces.filter((_, i) => Math.floor(i / 2) % 3 !== 1) : farPieces;
  const midVisible = mobile ? midPieces.filter((_, i) => Math.floor(i / 2) % 3 !== 2) : midPieces;
  const nearVisible = mobile ? nearPieces.filter((_, i) => Math.floor(i / 2) % 2 === 0) : nearPieces;
  return <group>
    <group ref={skyline}><Skyline theme={theme} /></group>
    <group ref={outer}>{outerVisible.map((piece, i) => <PieceAsset key={`o${i}`} piece={piece} theme={theme} zone="far" />)}</group>
    <group ref={far}>{farVisible.map((piece, i) => <PieceAsset key={`f${i}`} piece={piece} theme={theme} zone="far" />)}</group>
    <group ref={mid}>{midVisible.map((piece, i) => <PieceAsset key={`m${i}`} piece={piece} theme={theme} zone="mid" />)}</group>
    <group ref={near}>{nearVisible.map((piece, i) => <PieceAsset key={`n${i}`} piece={piece} theme={theme} zone="near" />)}</group>
    <group ref={utilities}>{Array.from({ length: poleCount }, (_, i) => [-1, 1].map(side => <group key={`${i}-${side}`} position={[(side as Side) * 9.25, -1.72, -20 - i * 12]}><UtilityCell theme={theme} side={side as Side} /></group>))}</group>
  </group>;
}
