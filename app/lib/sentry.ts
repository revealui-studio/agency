/** Consent-gated error reporting. Booking pages never enable replay or tracing. */
import * as Sentry from '@sentry/react';
import { analyticsAllowed, telemetryUrl } from './telemetry-privacy';

export interface SentryInitEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly MODE?: string;
  readonly PROD?: boolean;
}

export function readSentryDsn(
  env: Pick<SentryInitEnv, 'VITE_SENTRY_DSN'> = import.meta.env,
): string | null {
  return env.VITE_SENTRY_DSN?.trim() || null;
}

export const hasAnalyticsConsent = analyticsAllowed;

export function sentrySampleRates(_consent: boolean, _prod: boolean) {
  return { tracesSampleRate: 0, replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0 };
}

function redactBreadcrumb(crumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (!analyticsAllowed()) return null;
  if (!['fetch', 'xhr', 'navigation'].includes(crumb.category ?? '')) return null;
  const data: Record<string, string | number> = {};
  for (const key of ['url', 'from', 'to']) {
    const value: unknown = crumb.data?.[key];
    if (typeof value === 'string') data[key] = telemetryUrl(value);
  }
  const status: unknown = crumb.data?.status_code;
  if (typeof status === 'number') data.status_code = status;
  return { category: crumb.category, timestamp: crumb.timestamp, level: crumb.level, data };
}

function redactEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    event.request = {
      url: event.request.url ? telemetryUrl(event.request.url) : undefined,
      method: event.request.method,
    };
  }
  event.breadcrumbs = event.breadcrumbs?.flatMap((crumb) => {
    const safe = redactBreadcrumb(crumb);
    return safe ? [safe] : [];
  });
  // Free-form messages, user data and application context can contain capabilities or form data.
  event.message = undefined;
  event.user = undefined;
  event.extra = undefined;
  event.contexts = undefined;
  for (const exception of event.exception?.values ?? []) {
    exception.value = undefined;
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = telemetryUrl(frame.filename);
      if (frame.abs_path) frame.abs_path = telemetryUrl(frame.abs_path);
      frame.vars = undefined;
    }
  }
  return event;
}

export function initSentry(env: SentryInitEnv = import.meta.env): boolean {
  const dsn = readSentryDsn(env);
  if (!dsn || !analyticsAllowed() || Sentry.getClient()) return false;
  const prod = env.PROD === true;
  Sentry.init({
    dsn,
    environment: env.MODE ?? 'development',
    ...sentrySampleRates(true, prod),
    defaultIntegrations: false,
    integrations: [],
    sendClientReports: false,
    transport(options) {
      const transport = Sentry.makeFetchTransport(options);
      return {
        ...transport,
        send(envelope) {
          return analyticsAllowed()
            ? transport.send(envelope)
            : Promise.resolve({ statusCode: 200 });
        },
      };
    },
    sendDefaultPii: false,
    beforeBreadcrumb: redactBreadcrumb,
    beforeSend(event) {
      return prod && analyticsAllowed() ? redactEvent(event) : null;
    },
    beforeSendTransaction: () => null,
  });
  return true;
}

export function captureRenderError(error: Error, info: { componentStack?: string | null }): void {
  if (!readSentryDsn() || !analyticsAllowed() || !Sentry.getClient()) return;
  Sentry.withScope((scope) => {
    if (info.componentStack) scope.setExtra('componentStack', info.componentStack);
    Sentry.captureException(error);
  });
}
