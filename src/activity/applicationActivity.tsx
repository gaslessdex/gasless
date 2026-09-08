import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { APPLICATION_IDLE_MS, applicationActivityState, type ApplicationActivityState } from './activityState';
import { ActivityContext } from './applicationActivityContext';

export function ApplicationActivityProvider({ children }: { children: ReactNode }) {
  const lastActivityAt = useRef(Date.now());
  const [state, setState] = useState<ApplicationActivityState>(() => applicationActivityState(document.hidden, lastActivityAt.current, Date.now()));

  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      const next = applicationActivityState(document.hidden, lastActivityAt.current, Date.now());
      setState(next);
      if (!document.hidden) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(update, Math.max(1, APPLICATION_IDLE_MS - (Date.now() - lastActivityAt.current)));
      }
    };
    const activity = () => { lastActivityAt.current = Date.now(); update(); };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'touchstart', 'keydown', 'focus'];
    events.forEach((event) => window.addEventListener(event, activity, { passive: true }));
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, activity));
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const value = useMemo(() => ({ state, markActivity: () => { lastActivityAt.current = Date.now(); setState(document.hidden ? 'background' : 'active'); } }), [state]);
  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}
