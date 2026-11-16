import { useEffect } from 'react';

/**
 * Initialises the Sentry browser SDK once. Parent must only mount this
 * after analytics consent is true (same gate as Speed Insights / Umami).
 * Still a no-op when `VITE_SENTRY_DSN` is absent.
 */
export function SentryTracker() {
  useEffect(() => {
    let active = true;
    async function start() {
      const { initSentry } = await import('@/lib/sentry');
      if (active) initSentry();
    }
    void start();
    return () => {
      active = false;
    };
  }, []);

  return null;
}
