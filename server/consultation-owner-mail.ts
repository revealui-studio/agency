/** Gmail drafts are the durable send operation. Replays use the same draft ID. */

import { z } from 'zod';
import { OWNER_NOTIFY_EMAIL, type OwnerPaidNotice } from '../app/lib/consultation-owner.ts';
import {
  type CalendarPort,
  type ConsultationEnv,
  googleAccessToken,
} from './consultation-calendar.ts';
import { providerFetch } from './provider-http.ts';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function ownerMailConfigured(env: ConsultationEnv): boolean {
  return Boolean(
    (env.oauthClientId && env.oauthClientSecret && env.oauthRefreshToken) ||
      (env.googleClientEmail && env.googleCredential),
  );
}

export function ownerPaidRfc822(notice: OwnerPaidNotice, messageId?: string): string {
  // Subject is an application constant. Buyer fields belong only to the body.
  return [
    `From: "RevealUI Studio" <${OWNER_NOTIFY_EMAIL}>`,
    `To: ${OWNER_NOTIFY_EMAIL}`,
    `Subject: ${notice.subject}`,
    ...(messageId ? [`Message-ID: <${messageId}>`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    notice.text,
  ].join('\r\n');
}

async function messageKey(bookingId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bookingId)),
  );
  return `consultation-${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}@revealuistudio.com`;
}

function encodeRaw(message: string): string {
  const bytes = new TextEncoder().encode(message);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').split('=')[0] ?? '';
}

export async function deliverOwnerPaidNotice(
  env: ConsultationEnv,
  notice: OwnerPaidNotice,
  calendar: Pick<CalendarPort, 'get' | 'updateBooking'>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (notice.to !== OWNER_NOTIFY_EMAIL || !ownerMailConfigured(env))
    throw new Error('owner-notice-unconfigured');
  const booking = await calendar.get(notice.bookingId);
  if (booking?.status !== 'paid_scheduled') throw new Error('owner-notice-booking');
  if (booking.owner_notice?.messageId) return booking.owner_notice.messageId;
  const token = await googleAccessToken(env, fetchImpl, GMAIL_SCOPE);
  const key = await messageKey(notice.bookingId);
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await providerFetch(
      `${GMAIL}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      fetchImpl,
    );
    if (!response.ok) throw new Error('owner-notice-provider');
    return response.status === 204 ? null : response.json();
  };
  const recordSent = async (messageId: string) => {
    await calendar.updateBooking(notice.bookingId, (current) => ({
      ...current,
      owner_notice: { ...current.owner_notice, messageId },
    }));
    return messageId;
  };
  const findSent = async (): Promise<string | null> => {
    const query = new URLSearchParams({ q: `in:sent rfc822msgid:${key}`, maxResults: '2' });
    const found = z
      .object({ messages: z.array(z.object({ id: z.string().min(1) })).optional() })
      .parse(await request(`/messages?${query}`));
    const message = found.messages?.[0];
    if (!message) return null;
    return recordSent(message.id);
  };
  const alreadySent = await findSent();
  if (alreadySent) return alreadySent;
  let draftId = booking.owner_notice?.draftId;
  if (!draftId) {
    const created = z.object({ id: z.string().min(1) }).parse(
      await request('/drafts', 'POST', {
        message: { raw: encodeRaw(ownerPaidRfc822(notice, key)) },
      }),
    );
    const current = await calendar.updateBooking(notice.bookingId, (row) =>
      row.owner_notice?.draftId || row.owner_notice?.messageId
        ? row
        : { ...row, owner_notice: { draftId: created.id } },
    );
    draftId = current.owner_notice?.draftId;
    if (draftId !== created.id)
      await request(`/drafts/${encodeURIComponent(created.id)}`, 'DELETE');
    if (current.owner_notice?.messageId) return current.owner_notice.messageId;
  }
  if (!draftId) throw new Error('owner-notice-draft');
  try {
    // Gmail removes this draft when sent. A retry cannot send a new copy of it.
    const sent = z
      .object({ id: z.string().min(1) })
      .parse(await request('/drafts/send', 'POST', { id: draftId }));
    return recordSent(sent.id);
  } catch (error) {
    // A transport failure may have happened after Gmail sent it. Require provider proof.
    const recovered = await findSent();
    if (!recovered) throw error;
    return recovered;
  }
}
