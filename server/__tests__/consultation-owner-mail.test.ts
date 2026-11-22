/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { Booking } from '../../app/lib/consultation-booking';
import { buildOwnerPaidNotice } from '../../app/lib/consultation-owner';
import { createMemoryCalendar } from '../consultation-calendar';
import { deliverOwnerPaidNotice, ownerPaidRfc822 } from '../consultation-owner-mail';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRAFT_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';

const booking: Booking = {
  booking_id: 'book_owner',
  start: '2026-01-07T14:00:00.000Z',
  end: '2026-01-07T15:00:00.000Z',
  hours: 1,
  name: 'Ada Buyer',
  email: 'ada@example.com',
  company: null,
  stage_b: true,
  stage_b_fee: 'paid_addon',
  network_jti: null,
  status: 'paid_scheduled',
  expires_at: '2026-01-07T14:00:00.000Z',
  event_id: 'evt_owner',
  meet_link: 'https://meet.google.com/lookup/book_owner',
  stripe_session_id: 'cs_owner',
};

function decodeRaw(body: string): string {
  const payload = JSON.parse(body) as { raw?: string; message?: { raw?: string } };
  const raw = payload.raw ?? payload.message?.raw ?? '';
  const padded = raw.replaceAll('-', '+').replaceAll('_', '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

describe('owner paid mail', () => {
  it('addresses the founder and keeps Google Meet in the plain-text body', () => {
    const notice = buildOwnerPaidNotice(booking, 59_700);
    const message = ownerPaidRfc822(notice);
    expect(message.startsWith('From: "RevealUI Studio" <founder@revealui.com>\r\n')).toBe(true);
    expect(message).toContain('\r\nTo: founder@revealui.com\r\n');
    expect(message).not.toContain('To: ada@example.com');
    expect(message).toContain('Subject: RevealUI Studio Consultation paid');
    expect(message).toContain('Amount: $597');
    expect(message).toContain('Google Meet: https://meet.google.com/lookup/book_owner');
    expect(message).toContain('Domain add-on: yes');
    expect(message).toContain('Network: no');
    expect(message).not.toContain('RevealUIWordmark');
    expect(message).not.toContain('\u2014');
    expect(notice.text.replaceAll('Google Meet', '')).not.toMatch(/Meet/);
  });

  it('retries the persisted draft after failure and never duplicates a successful send', async () => {
    const calendar = createMemoryCalendar([booking]);
    let sends = 0;
    let drafts = 0;
    let sent = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === TOKEN_URL) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('/messages?'))
        return Response.json({ messages: sent ? [{ id: 'msg_1' }] : [] });
      if (url === DRAFT_URL) {
        drafts += 1;
        expect(decodeRaw(String(init?.body))).toContain('To: founder@revealui.com');
        return Response.json({ id: 'draft_1' });
      }
      if (url.endsWith('/drafts/send')) {
        sends += 1;
        expect(JSON.parse(String(init?.body))).toEqual({ id: 'draft_1' });
        if (sends === 1) return new Response('temporary', { status: 503 });
        sent = true;
        return Response.json({ id: 'msg_1' });
      }
      return new Response('missing', { status: 404 });
    };
    const env = {
      oauthClientId: 'notice-retry',
      oauthClientSecret: 'secret',
      oauthRefreshToken: 'refresh',
    };
    const notice = buildOwnerPaidNotice(booking, 59_700);
    await expect(deliverOwnerPaidNotice(env, notice, calendar, fetchImpl)).rejects.toThrow();
    expect((await calendar.get(booking.booking_id))?.owner_notice).toEqual({ draftId: 'draft_1' });
    expect(await deliverOwnerPaidNotice(env, notice, calendar, fetchImpl)).toBe('msg_1');
    expect(await deliverOwnerPaidNotice(env, notice, calendar, fetchImpl)).toBe('msg_1');
    expect({ sends, drafts }).toEqual({ sends: 2, drafts: 1 });
  });

  it('recovers provider evidence when sending succeeded before the connection failed', async () => {
    const calendar = createMemoryCalendar([booking]);
    let sent = false;
    let sends = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === TOKEN_URL) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('/messages?'))
        return Response.json({ messages: sent ? [{ id: 'msg_recovered' }] : [] });
      if (url === DRAFT_URL) return Response.json({ id: 'draft_1' });
      if (url.endsWith('/drafts/send')) {
        sends += 1;
        sent = true;
        throw new Error('connection-lost');
      }
      return new Response('missing', { status: 404 });
    };
    const env = {
      oauthClientId: 'notice-ambiguous',
      oauthClientSecret: 'secret',
      oauthRefreshToken: 'refresh',
    };
    const notice = buildOwnerPaidNotice(booking, 30_000);
    expect(await deliverOwnerPaidNotice(env, notice, calendar, fetchImpl)).toBe('msg_recovered');
    expect(await deliverOwnerPaidNotice(env, notice, calendar, fetchImpl)).toBe('msg_recovered');
    expect(sends).toBe(1);
  });
});
