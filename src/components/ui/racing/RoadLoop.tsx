import { useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import type { Theme } from '../../../types/app';
import { sceneVelocity } from './sceneMotion';

const SEGMENTS = 10;
const LENGTH = 18;

export function RoadLoop({ theme, slowed, steering, reducedMotion }: { theme: Theme; slowed: boolean; steering: MutableRefObject<number>; reducedMotion: boolean }) {
  const markings = useRef<Group>(null);
  const road = useRef<Group>(null);

  useFrame((_, delta) => {
    if (!markings.current) return;
    const speed = sceneVelocity(slowed, reducedMotion) * Math.min(delta, 0.04);
    for (const segment of markings.current.children) {
      segment.position.z += speed;
      if (segment.position.z > 11) segment.position.z -= SEGMENTS * LENGTH;
    }
    if (road.current) {
      const targetX = reducedMotion ? 0 : -steering.current * 2.35;
      road.current.position.x += (targetX - road.current.position.x) * .075;
      road.current.rotation.y += (steering.current * .012 - road.current.rotation.y) * .06;
    }
  });

  const asphalt = theme === 'dark' ? '#111111' : '#252525';
  const edge = theme === 'dark' ? '#dbdbd4' : '#f0f0e9';

  return (
    <group ref={road}>
      <mesh position={[0, -1.8, -80]} receiveShadow>
        <boxGeometry args={[15, 0.15, 190]} />
        <meshStandardMaterial color={asphalt} roughness={0.96} />
      </mesh>
      {[-6.5, 6.5].map((x) => (
        <mesh key={x} position={[x, -1.71, -80]}>
          <boxGeometry args={[0.18, 0.03, 189]} />
          <meshBasicMaterial color={edge} />
        </mesh>
      ))}
      <group ref={markings}>
        {Array.from({ length: SEGMENTS }, (_, index) => (
          <group key={index} position={[0, -1.7, -index * LENGTH]}>
          {[-2.45, 2.45].map((x) => (
            <mesh key={x} position={[x, 0, -3]}>
              <boxGeometry args={[0.12, 0.03, 5.8]} />
              <meshBasicMaterial color={edge} />
            </mesh>
          ))}
          </group>
        ))}
      </group>
    </group>
  );
}
