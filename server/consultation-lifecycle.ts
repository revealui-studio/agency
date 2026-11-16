/** Provider truth owns reservation retirement and compensation for unfulfillable payments. */
import { z } from 'zod';
import type { Booking } from '../app/lib/consultation-booking.ts';
import { providerFetch } from './provider-http.ts';

const sessionSchema = z.object({
  id: z.string().startsWith('cs_'),
  client_reference_id: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable(),
  status: z.enum(['open', 'complete', 'expired']),
  payment_status: z.enum(['paid', 'unpaid', 'no_payment_required']),
  payment_intent: z.string().nullable().optional(),
});

async function stripeRequest(
  secret: string | undefined,
  path: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
) {
  if (!secret) throw new Error('stripe-lifecycle-unconfigured');
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${secret}`);
  const response = await providerFetch(
    `https://api.stripe.com/v1${path}`,
    { ...init, headers },
    fetchImpl,
  );
  if (!response.ok) throw new Error('stripe-lifecycle-unavailable');
  return response.json();
}

function bound(session: z.infer<typeof sessionSchema>, bookingId: string) {
  return session.client_reference_id === bookingId && session.metadata?.booking_id === bookingId;
}

/** A timed-out create can have succeeded. Inspect every page before concluding no session exists. */
export async function checkoutCanRelease(
  booking: Booking,
  now: Date,
  secret: string | undefined,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  if (booking.status !== 'slot_held') return false;
  const expiry = Date.parse(booking.expires_at);
  if (!Number.isFinite(expiry)) throw new Error('booking-expiry');
  const sessions: z.infer<typeof sessionSchema>[] = [];
  if (booking.stripe_session_id) {
    sessions.push(
      sessionSchema.parse(
        await stripeRequest(
          secret,
          `/checkout/sessions/${encodeURIComponent(booking.stripe_session_id)}`,
          fetchImpl,
        ),
      ),
    );
  } else {
    // No marker means a pre-migration hold, whose original session was not persisted.
    const created = booking.checkout_started_at
      ? Date.parse(booking.checkout_started_at)
      : expiry - 24 * 60 * 60 * 1000;
    if (!Number.isFinite(created) || now.getTime() < expiry + 60_000) return false;
    let cursor = '';
    const seen = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({
        limit: '100',
        'created[gte]': String(Math.floor(created / 1000) - 60),
      });
      if (cursor) query.set('starting_after', cursor);
      const list = z
        .object({ has_more: z.boolean(), data: z.array(sessionSchema) })
        .parse(await stripeRequest(secret, `/checkout/sessions?${query}`, fetchImpl));
      for (const session of list.data) {
        if (seen.has(session.id)) throw new Error('stripe-pagination');
        seen.add(session.id);
        if (
          session.client_reference_id === booking.booking_id ||
          session.metadata?.booking_id === booking.booking_id
        )
          sessions.push(session);
      }
      if (!list.has_more) break;
      cursor = list.data.at(-1)?.id ?? '';
      if (!cursor || page === 99) throw new Error('stripe-pagination');
    }
  }
  for (let session of sessions) {
    if (!bound(session, booking.booking_id)) throw new Error('checkout-binding');
    if (session.payment_status === 'paid') return false;
    if (session.status === 'complete') {
      if (!session.payment_intent) return false;
      const intentPath = `/payment_intents/${encodeURIComponent(session.payment_intent)}`;
      let intent = z
        .object({ id: z.literal(session.payment_intent), status: z.string() })
        .parse(await stripeRequest(secret, intentPath, fetchImpl));
      if (intent.status === 'requires_payment_method') {
        intent = z
          .object({ id: z.literal(session.payment_intent), status: z.string() })
          .parse(
            await stripeRequest(secret, `${intentPath}/cancel`, fetchImpl, { method: 'POST' }),
          );
      }
      if (intent.status !== 'canceled') return false;
      continue;
    }
    if (session.status === 'open') {
      session = sessionSchema.parse(
        await stripeRequest(
          secret,
          `/checkout/sessions/${encodeURIComponent(session.id)}/expire`,
          fetchImpl,
          { method: 'POST' },
        ),
      );
    }
    if (
      !bound(session, booking.booking_id) ||
      session.status !== 'expired' ||
      session.payment_status !== 'unpaid'
    )
      return false;
  }
  return true;
}

/** Stripe persists the compensation; the same paid event cannot issue a second refund. */
export async function refundUnavailableReservation(
  bookingId: string,
  sessionId: string,
  secret: string | undefined,
  fetchImpl: typeof fetch,
) {
  const session = sessionSchema.parse(
    await stripeRequest(secret, `/checkout/sessions/${encodeURIComponent(sessionId)}`, fetchImpl),
  );
  if (
    session.id !== sessionId ||
    !bound(session, bookingId) ||
    session.payment_status !== 'paid' ||
    !session.payment_intent
  )
    throw new Error('refund-binding');
  // Idempotency keys expire at the provider. Recover the durable refund before
  // creating one even when this webhook is replayed weeks later.
  let cursor = '';
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ payment_intent: session.payment_intent, limit: '100' });
    if (cursor) query.set('starting_after', cursor);
    const list = z
      .object({
        has_more: z.boolean(),
        data: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            metadata: z.record(z.string(), z.string()),
          }),
        ),
      })
      .parse(await stripeRequest(secret, `/refunds?${query}`, fetchImpl));
    const previous = list.data.find(
      (refund) =>
        refund.metadata.checkout_session === sessionId &&
        refund.metadata.booking_id === bookingId &&
        refund.metadata.reason === 'reservation_unavailable',
    );
    if (previous) {
      if (previous.status !== 'succeeded') throw new Error('refund-pending');
      return previous.id;
    }
    if (!list.has_more) break;
    const next = list.data.at(-1)?.id;
    if (!next || next === cursor || page === 99) throw new Error('stripe-pagination');
    cursor = next;
  }
  const body = new URLSearchParams({
    payment_intent: session.payment_intent,
    'metadata[booking_id]': bookingId,
    'metadata[checkout_session]': sessionId,
    'metadata[reason]': 'reservation_unavailable',
  });
  const refund = z.object({ id: z.string().startsWith('re_'), status: z.string() }).parse(
    await stripeRequest(secret, '/refunds', fetchImpl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': `consultation-unavailable:${sessionId}`,
      },
      body,
    }),
  );
  // A replay of an idempotency response can contain an old pending status.
  const current = z
    .object({ id: z.literal(refund.id), status: z.string() })
    .parse(await stripeRequest(secret, `/refunds/${encodeURIComponent(refund.id)}`, fetchImpl));
  if (current.status !== 'succeeded') throw new Error('refund-pending');
  return current.id;
}
