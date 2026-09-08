import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type TurnstileApi = { render(container: HTMLElement, options: Record<string, unknown>): string; remove(widgetId: string): void; reset(widgetId: string): void };
declare global { interface Window { turnstile?: TurnstileApi } }

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
type GateState = 'checking' | 'challenging' | 'verified' | 'failed';

async function responseJson<T>(response: Response) { const value = await response.json().catch(() => ({})) as T & { error?: { message?: string } }; if (!response.ok) throw new Error(value.error?.message ?? "We couldn't verify this browser. Try again."); return value; }

export function BrowserVerificationGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking');
  const [attempt, setAttempt] = useState(0);
  const container = useRef<HTMLDivElement>(null);

  const fail = useCallback(() => setState('failed'), []);

  useEffect(() => {
    let cancelled = false; let widgetId: string | undefined;
    const run = async () => {
      setState('checking');
      const status = await fetch('/api/browser-verification/status', { cache: 'no-store' });
      if (status.ok) { if (!cancelled) setState('verified'); return; }
      const config = await responseJson<{ configured: boolean; siteKey?: string; action: string }>(await fetch('/api/browser-verification/config', { cache: 'no-store' }));
      if (!config.configured || !config.siteKey) throw new Error('Browser verification is not configured.');
      if (!cancelled) setState('challenging');
      let script = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT}"]`);
      if (!script) { script = document.createElement('script'); script.src = TURNSTILE_SCRIPT; script.async = true; script.defer = true; document.head.appendChild(script); }
      if (!window.turnstile) await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Turnstile failed to load.')), 8_000);
        const loaded = () => { window.clearTimeout(timeout); resolve(); };
        script!.addEventListener('load', loaded, { once: true });
        script!.addEventListener('error', () => { window.clearTimeout(timeout); reject(new Error('Turnstile failed to load.')); }, { once: true });
        const poll = window.setInterval(() => { if (window.turnstile) { window.clearInterval(poll); loaded(); } }, 50);
        window.setTimeout(() => window.clearInterval(poll), 8_000);
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (cancelled || !container.current || !window.turnstile) return;
      widgetId = window.turnstile.render(container.current, {
        sitekey: config.siteKey, action: config.action, appearance: 'interaction-only',
        callback: async (token: string) => {
          try {
            await responseJson(await fetch('/api/browser-verification/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() }, body: JSON.stringify({ token }) }));
            if (!cancelled) setState('verified');
          } catch { if (!cancelled) fail(); }
        },
        'error-callback': fail, 'expired-callback': () => widgetId && window.turnstile?.reset(widgetId),
      });
    };
    void run().catch(fail);
    return () => { cancelled = true; if (widgetId) window.turnstile?.remove(widgetId); };
  }, [attempt, fail]);

  if (state === 'verified') return children;
  return <main className="browser-verification-gate"><div className="browser-verification-panel" role={state === 'failed' ? 'alert' : 'status'}><span className="eyebrow">GASLESS / SECURITY</span><h1>{state === 'failed' ? "We couldn't verify this browser." : 'Checking your browser…'}</h1><p>{state === 'failed' ? 'Try again to open GASLESS.' : 'This normally takes only a moment.'}</p><div ref={container} className="turnstile-mount" />{state === 'failed' && <button type="button" onClick={() => setAttempt((value) => value + 1)}>TRY AGAIN</button>}</div></main>;
}
