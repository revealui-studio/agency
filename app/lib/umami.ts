/**
 * Self-hosted Umami pageview / UTM tracker config.
 *
 * The official `script.js` records History API navigations and sends the
 * current URL (including UTM query params) to `/api/send`. Load it only
 * after analytics consent is true — see `UmamiTracker`.
 *
 * Build-time env (set on the Vercel project for `test` and production):
 *   VITE_UMAMI_URL=https://revealui-umami.fly.dev
 *   VITE_UMAMI_WEBSITE_ID=0fbf4090-7768-47f8-9f85-5ab24a822160
 */

import { z } from 'zod';
import { analyticsAllowed, telemetryUrl } from './telemetry-privacy';

export const UMAMI_BEFORE_SEND = 'agencyBeforeUmamiSend';

/** Keep the callback installed after unmount: Umami's listeners may still be active. */
export function sanitizeUmamiPayload(_type: string, payload: Record<string, unknown>) {
  if (!analyticsAllowed()) return false;
  const safe = { ...payload };
  for (const key of ['url', 'referrer']) {
    if (typeof safe[key] === 'string') safe[key] = telemetryUrl(safe[key]);
  }
  return safe;
}

export const UMAMI_SCRIPT_FLAG = 'data-revealui-umami';

export interface UmamiConfig {
  url: string;
  websiteId: string;
}

export function readUmamiConfig(
  env: Pick<ImportMetaEnv, 'VITE_UMAMI_URL' | 'VITE_UMAMI_WEBSITE_ID'> = import.meta.env,
): UmamiConfig | null {
  const rawUrl = typeof env.VITE_UMAMI_URL === 'string' ? env.VITE_UMAMI_URL.trim() : '';
  const websiteId =
    typeof env.VITE_UMAMI_WEBSITE_ID === 'string' ? env.VITE_UMAMI_WEBSITE_ID.trim() : '';
  if (!rawUrl || !z.uuid().safeParse(websiteId).success) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return { url: parsed.origin, websiteId };
  } catch {
    return null;
  }
}

export function umamiScriptSrc(url: string): string {
  return `${url}/script.js`;
}
