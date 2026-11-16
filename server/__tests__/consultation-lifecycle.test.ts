/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { runPaidConsultation } from '../../app/lib/consultation-actions';
import { createHold } from '../../app/lib/consultation-booking';
import { createGoogleCalendar, createMemoryCalendar } from '../consultation-calendar';
import { checkoutCanRelease, refundUnavailableReservation } from '../consultation-lifecycle';

const now = new Date('2026-11-16T13:00:00Z');
const hold = createHold(
  {
    start: '2026-11-17T14:00:00Z',
    end: '2026-11-17T15:00:00Z',
    hours: 1,
    name: 'Test Buyer',
    email: 'buyer@example.com',
    company: null,
    stageB: false,
    stageBFee: 'none',
    networkJti: null,
  },
  now,
  'test-booking',
);
const later = new Date(now.getTime() + 41 * 60_000);
const session = {
  id: 'cs_test',
  client_reference_id: hold.booking_id,
  metadata: { booking_id: hold.booking_id },
  status: 'open',
  payment_status: 'unpaid',
  payment_intent: 'pi_test',
};

describe('reservation lifecycle', () => {
  it('does not recreate a reservation removed after the action read', async () => {
    const calendar = createMemoryCalendar([hold]);
    const stale = await calendar.get(hold.booking_id);
    await calendar.release(hold.booking_id);
    const result = await runPaidConsultation(
      {
        paymentStatus: 'paid',
        sessionId: 'cs_test',
        metadata: { booking_id: hold.booking_id },
        booking: stale,
      },
      { now, calendar },
    );
    expect(result).toEqual({ ok: false, error: 'hold-missing' });
    expect(await calendar.get(hold.booking_id)).toBeNull();
  });
  it('expires an open Checkout before releasing and retains paid/pending sessions', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return Response.json({
        ...session,
        status: String(url).endsWith('/expire') ? 'expired' : 'open',
      });
    };
    const bound = {
      ...hold,
      stripe_session_id: session.id,
      checkout_started_at: now.toISOString(),
    };
    expect(await checkoutCanRelease(bound, later, 'synthetic', fetchImpl)).toBe(true);
    expect(calls[1]).toContain('/cs_test/expire');
    for (const payment_status of ['paid', 'unpaid']) {
      expect(
        await checkoutCanRelease(bound, later, 'synthetic', async (input) =>
          String(input).includes('/payment_intents/')
            ? Response.json({ id: 'pi_test', status: 'processing' })
            : Response.json({ ...session, status: 'complete', payment_status }),
        ),
      ).toBe(false);
    }
  });
  it('finds an ambiguous create on a later page and fails closed on incomplete provider data', async () => {
    const pending = { ...hold, checkout_started_at: now.toISOString() };
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      return Response.json(
        url.searchParams.has('starting_after')
          ? { has_more: false, data: [{ ...session, status: 'complete', payment_status: 'paid' }] }
          : {
              has_more: true,
              data: [
                {
                  ...session,
                  id: 'cs_other',
                  client_reference_id: 'other',
                  metadata: { booking_id: 'other' },
                },
              ],
            },
      );
    };
    expect(await checkoutCanRelease(pending, later, 'synthetic', fetchImpl)).toBe(false);
    await expect(
      checkoutCanRelease(pending, later, 'synthetic', async () =>
        Response.json({ has_more: true, data: [] }),
      ),
    ).rejects.toThrow();
    await expect(checkoutCanRelease(pending, later, undefined, fetchImpl)).rejects.toThrow(
      'unconfigured',
    );
  });
  it('uses the observed ETag and does not retry a deletion after payment wins', async () => {
    let deleteEtag: string | null = null;
    let deletes = 0;
    const event = {
      id: 'evt_test',
      etag: '"revision-one"',
      extendedProperties: {
        private: {
          kind: 'studio-consultation',
          booking_id: hold.booking_id,
          status: 'slot_held',
          hours: '1',
          start: hold.start,
          end: hold.end,
          expires_at: hold.expires_at,
          buyer_name: hold.name,
          buyer_email: hold.email,
        },
      },
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com')
        return Response.json({ access_token: 'synthetic', expires_in: 3600 });
      if (url.hostname === 'api.stripe.com') return Response.json({ has_more: false, data: [] });
      if (init?.method === 'DELETE') {
        deletes += 1;
        deleteEtag = new Headers(init.headers).get('if-match');
        event.extendedProperties.private.status = 'paid_scheduled';
        return new Response(null, { status: 412 });
      }
      return Response.json({ items: [event] });
    };
    const calendar = createGoogleCalendar(
      {
        calendarId: 'test@example.com',
        oauthClientId: 'lifecycle',
        oauthClientSecret: 'synthetic',
        oauthRefreshToken: 'synthetic',
        stripeSecretKey: 'synthetic',
      },
      fetchImpl,
    );
    await calendar.expireHolds(later);
    expect(deleteEtag).toBe(event.etag);
    expect(deletes).toBe(1);
    expect((await calendar.get(hold.booking_id))?.status).toBe('paid_scheduled');
  });
  it('refunds an unavailable reservation with a stable provider idempotency key', async () => {
    const keys: Array<string | null> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes('/checkout/'))
        return Response.json({ ...session, status: 'complete', payment_status: 'paid' });
      if (String(input).includes('/refunds?')) return Response.json({ has_more: false, data: [] });
      if (init?.method === 'POST') keys.push(new Headers(init.headers).get('idempotency-key'));
      return Response.json({ id: 're_test', status: 'succeeded' });
    };
    await refundUnavailableReservation(hold.booking_id, session.id, 'synthetic', fetchImpl);
    await refundUnavailableReservation(hold.booking_id, session.id, 'synthetic', fetchImpl);
    expect(keys).toEqual(['consultation-unavailable:cs_test', 'consultation-unavailable:cs_test']);
  });
  it('retains a hold when Stripe returns a different session during retrieval or expiry', async () => {
    const bound = { ...hold, stripe_session_id: session.id };
    for (const mismatchOn of ['read', 'expire']) {
      await expect(
        checkoutCanRelease(bound, later, 'synthetic', async (input) => {
          const expiring = String(input).endsWith('/expire');
          return Response.json({
            ...session,
            id: (mismatchOn === 'expire') === expiring ? 'cs_other' : session.id,
            status: expiring ? 'expired' : 'open',
          });
        }),
      ).rejects.toThrow('checkout-binding');
    }
  });

  it('recovers durable compensation evidence instead of refunding again on a late replay', async () => {
    for (const status of ['succeeded', 'pending']) {
      const methods: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        methods.push(init?.method ?? 'GET');
        if (String(input).includes('/checkout/'))
          return Response.json({ ...session, status: 'complete', payment_status: 'paid' });
        return Response.json({
          has_more: false,
          data: [
            {
              id: 're_previous',
              status,
              metadata: {
                booking_id: hold.booking_id,
                checkout_session: session.id,
                reason: 'reservation_unavailable',
              },
            },
          ],
        });
      };
      const replay = refundUnavailableReservation(
        hold.booking_id,
        session.id,
        'synthetic',
        fetchImpl,
      );
      if (status === 'succeeded') await expect(replay).resolves.toBe('re_previous');
      else await expect(replay).rejects.toThrow('refund-pending');
      expect(methods).toEqual(['GET', 'GET']);
    }
  });
});
