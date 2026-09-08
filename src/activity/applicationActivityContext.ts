import { createContext, useContext } from 'react';
import type { ApplicationActivityState } from './activityState';

export const ActivityContext = createContext<{ state: ApplicationActivityState; markActivity: () => void }>({ state: 'active', markActivity: () => undefined });
export function useApplicationActivity() { return useContext(ActivityContext); }
