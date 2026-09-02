import { Component, type MutableRefObject, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { EnvironmentLoop } from './EnvironmentLoop';
import { RoadLoop } from './RoadLoop';
import type { Theme } from '../../../types/app';

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function CameraRig({ steering, reducedMotion }: { steering: MutableRefObject<number>; reducedMotion: boolean }) {
  useFrame(({ camera, clock }) => {
    const target = steering.current * 0.045;
    camera.position.x += (target - camera.position.x) * 0.035;
    camera.rotation.z += (-steering.current * 0.004 - camera.rotation.z) * 0.04;
    camera.position.y = 2.6 + (reducedMotion ? 0 : Math.sin(clock.elapsedTime * 17) * 0.006);
  });
  return null;
}

export function RacingScene({ theme, steering, slowed, reducedMotion }: {
  theme: Theme;
  steering: MutableRefObject<number>;
  slowed: boolean;
  reducedMotion: boolean;
}) {
  const fallback = <div className="scene-fallback" aria-label="Static racing cockpit fallback"><div className="fallback-road" /></div>;
  return (
    <SceneBoundary fallback={fallback}>
      <Canvas
        className="race-canvas"
        camera={{ position: [0, 2.6, 7.8], fov: 58, near: 0.1, far: 220 }}
        dpr={[1, Math.min(1.6, devicePixelRatio)]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true }}
        onCreated={({ gl }) => gl.setClearColor('#000000', 0)}
      >
        <fog attach="fog" args={[theme === 'dark' ? '#141617' : '#d7d7d1', 38, 150]} />
        <hemisphereLight args={[theme === 'dark' ? '#bdbdb8' : '#ffffff', '#111111', theme === 'dark' ? 1.25 : 1.8]} />
        <directionalLight position={[5, 10, 3]} intensity={theme === 'dark' ? 2.2 : 3.2} color="#ffffff" />
        <RoadLoop theme={theme} slowed={slowed} steering={steering} reducedMotion={reducedMotion} />
        <EnvironmentLoop theme={theme} steering={steering} slowed={slowed} reducedMotion={reducedMotion} />
        <CameraRig steering={steering} reducedMotion={reducedMotion} />
      </Canvas>
    </SceneBoundary>
  );
}
