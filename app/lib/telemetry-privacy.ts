import { readConsent } from './cookie-consent';

/** Telemetry never needs a booking capability, query string, fragment or URL credentials. */
export function telemetryUrl(value: string): string {
  try {
    const absolute = URL.canParse(value);
    const url = new URL(value, 'https://revealuistudio.com');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '[redacted]';
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return absolute ? url.href : url.pathname;
  } catch {
    return '[redacted]';
  }
}

export function analyticsAllowed(): boolean {
  return readConsent().consent.analytics;
}

/** Also runs for clients which were loaded before consent was withdrawn. */
export function beforeSpeedSend<T extends { url: string }>(event: T): T | null {
  return analyticsAllowed() ? { ...event, url: telemetryUrl(event.url) } : null;
}
