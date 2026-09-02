import * as Sentry from '@sentry/node';
import type { GaslessError } from '../errors.js';

const blocked = /secret|token|authorization|api[-_]?key|private[-_]?key|seed|signed[-_]?transaction|payload/i;

export function initializeServerSentry(dsn: string | undefined, environment: string) {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment,
    sendDefaultPii: false,
    beforeSend(event) {
      delete event.user;
      delete event.request;
      delete event.breadcrumbs;
      if (event.extra) event.extra = Object.fromEntries(Object.entries(event.extra).filter(([key]) => !blocked.test(key)));
      return event;
    },
  });
}

export function captureOperationalFailure(error: GaslessError, context: { requestId: string; route: string; network: string; operatingMode: string }) {
  if (['RATE_LIMITED', 'REPLAY_DETECTED', 'WALLET_NOT_ALLOWED', 'QUOTE_EXPIRED', 'QUOTE_ALREADY_USED', 'INVALID_REQUEST'].includes(error.code)) return;
  Sentry.withScope((scope) => {
    scope.setTags({ code: error.code, stage: error.stage, network: context.network, operatingMode: context.operatingMode });
    scope.setContext('request', { requestId: context.requestId, route: context.route });
    Sentry.captureException(error);
  });
}
