import { useEffect } from 'react';
import {
  readUmamiConfig,
  sanitizeUmamiPayload,
  UMAMI_BEFORE_SEND,
  UMAMI_SCRIPT_FLAG,
  umamiScriptSrc,
} from '@/lib/umami';

/**
 * Injects the self-hosted Umami tracker once. Parent must only mount this
 * after analytics consent is true (same gate as Speed Insights).
 */
export function UmamiTracker() {
  useEffect(() => {
    const config = readUmamiConfig();
    if (!config) return;
    Object.assign(window, { [UMAMI_BEFORE_SEND]: sanitizeUmamiPayload });
    if (document.querySelector(`script[${UMAMI_SCRIPT_FLAG}]`)) return;

    const script = document.createElement('script');
    script.defer = true;
    script.src = umamiScriptSrc(config.url);
    script.dataset.websiteId = config.websiteId;
    script.dataset.beforeSend = UMAMI_BEFORE_SEND;
    script.setAttribute(UMAMI_SCRIPT_FLAG, '');
    document.head.appendChild(script);
  }, []);

  return null;
}
