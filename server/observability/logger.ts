type LogLevel = 'info' | 'warn' | 'error';

const REDACTED_KEYS = /secret|token|authorization|api[-_]?key|private[-_]?key/i;

export function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/(https?:\/\/[^\s?]+)\?\S+/gi, '$1?[REDACTED]').replace(/(?:authorization|api[-_]?key|token|secret)\s*[:=]\s*\S+/gi, '[REDACTED_CREDENTIAL]').slice(0, 512);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, REDACTED_KEYS.test(key) ? '[REDACTED]' : sanitizeLogValue(item)]));
}

export function log(level: LogLevel, event: string, context: Record<string, unknown> = {}) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...(sanitizeLogValue(context) as Record<string, unknown>) });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.info(entry);
}
