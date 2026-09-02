import * as Sentry from '@sentry/react';

const secretValuePattern =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|seed(?:[_-]?phrase)?|secret|signature|signed[_-]?transaction|transaction[_-]?payload)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const bearerTokenPattern = /\bBearer\s+[^\s,;]+/gi;

function scrubText(value: string | undefined): string | undefined {
  return value
    ?.replace(bearerTokenPattern, 'Bearer [Filtered]')
    .replace(secretValuePattern, '$1=[Filtered]');
}

function stripUrlData(value: string | undefined): string | undefined {
  if (!value) return value;

  try {
    const url = new URL(value, window.location.origin);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

export function initializeSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();

  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    integrations(defaultIntegrations) {
      return defaultIntegrations.filter(
        (integration) =>
          integration.name !== 'Breadcrumbs' &&
          integration.name !== 'BrowserSession',
      );
    },
    beforeSend(event) {
      delete event.user;
      delete event.extra;
      delete event.breadcrumbs;

      event.message = scrubText(event.message);

      for (const exception of event.exception?.values ?? []) {
        exception.value = scrubText(exception.value);
      }

      if (event.request) {
        event.request = {
          method: event.request.method,
          url: stripUrlData(event.request.url),
        };
      }

      return event;
    },
  });
}
