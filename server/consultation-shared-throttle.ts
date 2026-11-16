/** Shared Vercel enforcement; local maps own only the availability cache. */
import { checkRateLimit } from '@vercel/firewall';
import {
  type ConsultationThrottle,
  clientAddress,
  createConsultationThrottle,
} from './consultation-rate-limit.ts';

export const CONSULTATION_QUOTAS = {
  '/api/consultation/availability': { id: 'agency-consultation-availability', limit: 30 },
  '/api/consultation/book': { id: 'agency-consultation-book', limit: 10 },
  '/api/consultation/booking': { id: 'agency-consultation-booking', limit: 30 },
} as const;

/** Generated production deployment URLs can require SSO; the configured public origin does not. */
export function consultationFirewallHost(
  publicOrigin: string | undefined,
  environment: string | undefined = process.env.VERCEL_ENV,
  deploymentHost: string | undefined = process.env.VERCEL_URL,
): string | undefined {
  if (environment !== 'production') return deploymentHost;
  if (!publicOrigin) return undefined;
  try {
    const url = new URL(publicOrigin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.host;
  } catch {
    return undefined;
  }
}

export function createSharedConsultationThrottle(
  host: string | undefined,
  check: typeof checkRateLimit = checkRateLimit,
): ConsultationThrottle {
  const cache = createConsultationThrottle();
  return {
    ...cache,
    async consume(request, path) {
      if (!(path in CONSULTATION_QUOTAS)) return null;
      const quota = CONSULTATION_QUOTAS[path as keyof typeof CONSULTATION_QUOTAS];
      try {
        if (!host || new URL(`https://${host}`).host !== host) throw new Error('quota-host');
        const result = await check(quota.id, {
          headers: new Headers({ host }),
          rateLimitKey: clientAddress(request),
          firewallHostForDevelopment: host,
          timeout: 2000,
        });
        if (result.error === 'not-found') throw new Error('quota-unconfigured');
        if (result.rateLimited)
          return Response.json(
            { error: 'rate-limited', message: 'Too many requests. Please retry shortly.' },
            {
              status: 429,
              headers: { 'retry-after': '60', 'cache-control': 'private, no-store' },
            },
          );
        return null;
      } catch {
        return Response.json(
          { error: 'rate-limit-unavailable' },
          {
            status: 503,
            headers: { 'retry-after': '60', 'cache-control': 'private, no-store' },
          },
        );
      }
    },
  };
}
