/**
 * Payment entities: order, payment
 */
import { define } from '@janus/core';
import {
  Str, IntCents, Email, Url, Private, Persistent, Relation,
} from '@janus/vocabulary';
import { orderLifecycle, paymentLifecycle } from '../lifecycles';

// ── Order ─────────────────────────────────────────────────────────
export const order = define('order', {
  schema: Private({
    email: Email({ required: true }),
    lineItems: Str({ required: true, searchable: false }),
    totalCents: IntCents({ required: true, as: 'amount' }),
    currency: Str({ required: true }),
    providerSessionId: Str({ searchable: false }),
    checkoutUrl: Url({ searchable: false }),
    status: orderLifecycle,
  }),
  storage: Persistent(),
  description: 'Cart checkout order',
  owned: true,
});

// ── Payment ───────────────────────────────────────────────────────
export const payment = define('payment', {
  schema: Private({
    amountCents: IntCents({ required: true, as: 'amount' }),
    currency: Str({ required: true }),
    providerSessionId: Str({ searchable: false }),
    checkoutUrl: Url({ searchable: false }),
    orderId: Relation('order'),
    status: paymentLifecycle,
  }),
  storage: Persistent(),
  description: 'Payment record linked to an order',
});
