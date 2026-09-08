export const APPLICATION_IDLE_MS = 3 * 60 * 1000;
export type ApplicationActivityState = 'active' | 'idle' | 'background';

export function applicationActivityState(hidden: boolean, lastActivityAt: number, now: number, idleMs = APPLICATION_IDLE_MS): ApplicationActivityState {
  if (hidden) return 'background';
  return now - lastActivityAt >= idleMs ? 'idle' : 'active';
}

export function activityHeaders(state: ApplicationActivityState) { return { 'X-Gasless-Activity': state }; }
