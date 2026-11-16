import { afterEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_NAME, DENIED, readConsent, writeConsent } from '../cookie-consent';
import { beforeSpeedSend, telemetryUrl } from '../telemetry-privacy';
import { sanitizeUmamiPayload } from '../umami';

afterEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: clear test consent
  document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/`;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('telemetry privacy', () => {
  it('strips query, fragment and URL credentials from absolute and relative URLs', () => {
    expect(telemetryUrl('https://buyer:secret@example.com/book?nw=cap#token')).toBe(
      'https://example.com/book',
    );
    expect(telemetryUrl('/book?session_id=cap#token')).toBe('/book');
    expect(telemetryUrl('javascript:secret')).toBe('[redacted]');
  });
  it('rechecks consent for loaded Umami and Speed Insights clients', () => {
    writeConsent({ ...DENIED, analytics: true });
    const url = 'https://example.com/book?nw=cap';
    expect(beforeSpeedSend({ url })).toEqual({ url: 'https://example.com/book' });
    expect(sanitizeUmamiPayload('event', { url, referrer: url })).toEqual({
      url: 'https://example.com/book',
      referrer: 'https://example.com/book',
    });
    writeConsent(DENIED);
    expect(beforeSpeedSend({ url })).toBeNull();
    expect(sanitizeUmamiPayload('event', { url })).toBe(false);
  });
  it('honors privacy signals even with a saved accept', () => {
    writeConsent({ ...DENIED, analytics: true });
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    expect(readConsent().consent.analytics).toBe(false);
  });
});
