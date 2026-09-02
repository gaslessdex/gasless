import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { LoadingSequence } from '../components/feedback/LoadingSequence';
import { SkyLayer } from '../components/ui/racing/SkyLayer';
import { CarRig } from '../components/ui/racing/CarRig';
import { TopHud, type HudPanel } from '../components/ui/TopHud';
import { FeatureConsole } from '../components/ui/FeatureConsole';
import { FaqConsole } from '../components/ui/FaqConsole';
import { MobileActionRail } from '../components/ui/MobileActionRail';
import { MobileMenu } from '../components/navigation/MobileMenu';
import type { Feature } from '../types/app';
import { DevnetProofPanel } from '../features/devnet-proof/DevnetProofPanel';
import { appNetwork } from '../config/network';

const RacingScene = lazy(() => import('../components/ui/racing/RacingScene').then((module) => ({ default: module.RacingScene })));

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch { return false; }
}

function pointerSteer(clientX: number) {
  const raw = Math.max(-1, Math.min(1, (clientX / window.innerWidth) * 2 - 1));
  const deadZone = 0.065;
  if (Math.abs(raw) <= deadZone) return 0;
  const eased = (Math.abs(raw) - deadZone) / (1 - deadZone);
  return Math.sign(raw) * eased * eased * (3 - 2 * eased);
}

export function App() {
  const { theme, setTheme } = useTheme();
  const [booted, setBooted] = useState(false);
  const [panel, setPanel] = useState<HudPanel>(null);
  const [feature, setFeature] = useState<Feature | null>(null);
  const [hoveredAction, setHoveredAction] = useState<Feature | null>(null);
  const [consoleClosing, setConsoleClosing] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const actionTriggerId = useRef<Feature | null>(null);
  const app = useRef<HTMLElement>(null);
  const steering = useRef(0);
  const steeringVelocity = useRef(0);
  const targetSteering = useRef(0);
  const reducedMotion = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const [steeringEnabled, setSteeringEnabled] = useState(() => matchMedia('(hover: hover) and (pointer: fine)').matches);
  const webgl = useMemo(supportsWebGL, []);

  useEffect(() => {
    const query = matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setSteeringEnabled(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    const update = (now: number) => {
      const dt = Math.min((now - previous) / 16.667, 2);
      previous = now;
      const stiffness = reducedMotion ? 0.34 : 0.14;
      const drag = reducedMotion ? 0.48 : 0.58;
      steeringVelocity.current = (steeringVelocity.current + (targetSteering.current - steering.current) * stiffness * dt) * drag;
      steering.current += steeringVelocity.current * dt;
      if (Math.abs(steering.current) < 0.0005 && targetSteering.current === 0) steering.current = 0;
      const steer = steering.current;
      const root = app.current?.style;
      root?.setProperty('--steer', steer.toFixed(4));
      root?.setProperty('--vanishing-offset', `${(-steer * 1.8).toFixed(2)}px`);
      root?.setProperty('--far-offset', `${(-steer * 14).toFixed(2)}px`);
      root?.setProperty('--mid-offset', `${(-steer * 44).toFixed(2)}px`);
      root?.setProperty('--near-offset', `${(-steer * 92).toFixed(2)}px`);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion]);

  useEffect(() => {
    if (panel || feature || faqOpen || menuOpen) targetSteering.current = 0;
  }, [panel, feature, faqOpen, menuOpen]);

  const handlePointer = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (panel || feature || faqOpen || menuOpen || !steeringEnabled || event.pointerType !== 'mouse') return;
    targetSteering.current = pointerSteer(event.clientX);
  }, [panel, feature, faqOpen, menuOpen, steeringEnabled]);

  const openFeature = useCallback((nextFeature: Feature, trigger: HTMLButtonElement) => {
    actionTrigger.current = trigger;
    actionTriggerId.current = nextFeature;
    setPanel(null);
    setHoveredAction(null);
    setConsoleClosing(false);
    setFeature(nextFeature);
    setFaqOpen(false);
    setMenuOpen(false);
  }, []);

  const openFaq = useCallback(() => {
    setPanel(null);
    setFeature(null);
    setMenuOpen(false);
    setFaqOpen(true);
  }, []);

  const closeFeature = useCallback(() => {
    if (consoleClosing) return;
    setConsoleClosing(true);
    window.setTimeout(() => {
      setFeature(null);
      setConsoleClosing(false);
      window.setTimeout(() => (actionTrigger.current ?? document.querySelector<HTMLButtonElement>(`#action-trigger-${actionTriggerId.current}`))?.focus(), 30);
    }, reducedMotion ? 30 : 240);
  }, [consoleClosing, reducedMotion]);

  return (
    <main
      ref={app}
      className={`app-shell theme-${theme}${panel ? ' has-drawer' : ''}${feature || faqOpen || menuOpen ? ' has-console' : ''}`}
      onPointerMove={handlePointer}
      onPointerLeave={() => { targetSteering.current = 0; }}
    >
      <div className="app-background" aria-hidden={feature || faqOpen || menuOpen ? 'true' : undefined} inert={feature || faqOpen || menuOpen ? true : undefined}>
      <div className="scene-layer" aria-hidden="true">
        <SkyLayer theme={theme} />
        {webgl ? (
          <Suspense fallback={<div className="scene-fallback"><div className="fallback-road" /></div>}>
            <RacingScene theme={theme} steering={steering} slowed={Boolean(panel || feature)} reducedMotion={reducedMotion} />
          </Suspense>
        ) : <div className="scene-fallback"><div className="fallback-road" /></div>}
      </div>

      <CarRig theme={theme} activeAction={hoveredAction} consoleOpen={Boolean(feature || faqOpen || menuOpen)} onActionHover={setHoveredAction} onActionSelect={openFeature} onFaqSelect={openFaq} onMobileMenu={() => setMenuOpen(true)} />
      <MobileActionRail onSelect={openFeature} />
      </div>
      <TopHud theme={theme} onThemeChange={setTheme} panel={panel} onPanelChange={(next) => { setMenuOpen(false); setFaqOpen(false); setPanel(next); }} />
      {feature && <FeatureConsole feature={feature} closing={consoleClosing} onClose={closeFeature} />}
      {faqOpen && <FaqConsole onClose={() => setFaqOpen(false)} />}
      {menuOpen && <MobileMenu theme={theme} onClose={() => setMenuOpen(false)} onPanelSelect={(next) => { setMenuOpen(false); setPanel(next); }} onFaqSelect={openFaq} />}
      {!booted && <LoadingSequence onComplete={() => setBooted(true)} reducedMotion={reducedMotion} />}
      {import.meta.env.DEV && appNetwork === 'devnet' && new URLSearchParams(window.location.search).has('proof') && <DevnetProofPanel />}
      <div className="screen-grain" aria-hidden="true" />
    </main>
  );
}
