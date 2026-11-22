/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import {
  consultationFirewallHost,
  createSharedConsultationThrottle,
} from '../consultation-shared-throttle';

const request = new Request('https://example.com/api/consultation/book', {
  headers: { 'x-real-ip': '192.0.2.1' },
});
const path = '/api/consultation/book';

describe('shared consultation quotas', () => {
  it('uses the configured public production origin while preserving preview isolation', () => {
    expect(
      consultationFirewallHost('https://revealuistudio.com/', 'production', 'protected.vercel.app'),
    ).toBe('revealuistudio.com');
    expect(
      consultationFirewallHost('https://revealuistudio.com/', 'preview', 'preview.vercel.app'),
    ).toBe('preview.vercel.app');
    for (const origin of [
      undefined,
      'http://example.com',
      'https://user:secret@example.com',
      'https://example.com/path',
      'https://example.com/?secret=value',
    ]) {
      expect(
        consultationFirewallHost(origin, 'production', 'protected.vercel.app'),
      ).toBeUndefined();
    }
  });

  it('shares enforcement between instances and across a cold start', async () => {
    let count = 0;
    const provider = async () => ({ rateLimited: ++count > 2 });
    const first = createSharedConsultationThrottle('example.com', provider);
    const second = createSharedConsultationThrottle('example.com', provider);
    expect(await first.consume(request, path, 0)).toBeNull();
    expect(await second.consume(request, path, 0)).toBeNull();
    const restarted = createSharedConsultationThrottle('example.com', provider);
    const rejected = await restarted.consume(request, path, 0);
    expect(rejected?.status).toBe(429);
    expect(rejected?.headers.get('retry-after')).toBe('60');
  });
  it('fails closed for missing rules, missing configuration and provider failures', async () => {
    const missing = createSharedConsultationThrottle('example.com', async () => ({
      rateLimited: false,
      error: 'not-found',
    }));
    expect((await missing.consume(request, path, 0))?.status).toBe(503);
    const down = createSharedConsultationThrottle('example.com', async () => {
      throw new Error('unavailable');
    });
    expect((await down.consume(request, path, 0))?.status).toBe(503);
    expect(await down.consume(request, '/api/stripe/webhook', 0)).toBeNull();
  });
});
