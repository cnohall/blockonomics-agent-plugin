---
name: callback-handling
description: Guide for receiving and verifying Blockonomics payment callbacks, covering the GET query parameters, confirmation status values, secret verification, RBF safety, idempotency, and retry behaviour.
---

# Blockonomics Callback Handling

Callbacks are how a payment becomes real to the application. Everything else in the integration is presentation.

## When to use this skill

- Writing or reviewing the endpoint that receives payment notifications
- Verifying that a callback genuinely came from Blockonomics
- Handling the confirmation status progression
- Making callback processing idempotent
- Debugging callbacks that fire more than once, or not at all

---

## Core facts

**It is a `GET`, not a `POST`.** Every field arrives as a query parameter. There is no JSON body, and there is no HMAC signature header. A handler written as `app.post(...)` expecting `req.body` will never fire.

**Verification is by shared secret in the URL.** The merchant chooses the secret and embeds it in the callback URL registered on the store:

```
https://yoursite.com/api/payment-callback?secret=RANDOM_SECRET
```

Blockonomics appends its own parameters to that URL, so the secret arrives alongside them. This is the only authentication the callback carries — it must be checked on every request.

---

## Query parameters

| Parameter | Type | Description |
|---|---|---|
| `addr` | string | The address that received payment. The join key back to the order. |
| `crypto` | string | Absent or `BTC` for Bitcoin, `USDT` for USDT. **Absence means BTC.** |
| `status` | integer | Confirmation status. See below. |
| `value` | integer | Amount received. Satoshis for BTC, base units (6 dp) for USDT. |
| `txid` | string | On-chain transaction ID. |
| `rbf` | integer | **Present only** on unconfirmed Replace-By-Fee transactions. |

### Status values

| Value | Meaning | Safe to fulfill |
|---|---|---|
| `0` | Unconfirmed, in mempool | No |
| `1` | 1 confirmation | No |
| `2` | 2+ confirmations, final | Yes |

For e-commerce, treat `status >= 2` as payment. Use `>=` rather than `=== 2`, so the check does not break if a higher status is ever introduced.

---

## The RBF trap

`rbf` is present **only when there is a problem**, which makes it easy to miss: it is absent from every callback in a normal test run, so a handler that ignores it passes testing and fails in production.

A Replace-By-Fee transaction can be replaced by the sender with a different transaction — including one that pays the merchant nothing — at any point before confirmation. Any integration that acts on `status = 0` must reject callbacks carrying `rbf`:

```javascript
if (status === 0 && "rbf" in req.query) {
  // Sender can still cancel or redirect this payment. Show nothing optimistic.
  return res.send("OK");
}
```

The safe default is not to act on `status = 0` at all. Only accept zero-confirmation payments if the business has explicitly accepted the fraud risk for low-value, instantly-revocable goods.

---

## Delivery behaviour

- A callback is successful when the server returns HTTP **200**. Any other status counts as a failure.
- Failed callbacks are retried up to **7 times** with exponential backoff starting at 4 seconds.
- Callbacks are only sent for transactions with a value greater than zero.
- Each unique combination of `txid`, `status`, and `addr` is sent **only once** on success.

That last rule is the one to design against. A single payment produces roughly three callbacks (`0`, `1`, `2`) for the same `addr` and `txid`. Retries add more. The handler must be idempotent or the same order gets fulfilled repeatedly.

---

## Reference implementation

```javascript
// Express. Note: GET, and req.query - not POST, not req.body.
app.get("/api/payment-callback", async (req, res) => {
  const { secret, addr, status, value, txid, crypto, rbf } = req.query;

  // 1. Verify the shared secret with a constant-time comparison.
  if (!secret || !timingSafeEqualStr(secret, process.env.BLOCKONOMICS_CALLBACK_SECRET)) {
    return res.status(403).send("Forbidden");
  }

  // 2. Acknowledge immediately. Blockonomics retries on any non-200, and slow
  //    handlers turn into duplicate deliveries.
  res.send("OK");

  // 3. Everything below runs after the response.
  const confirmations = parseInt(status, 10);
  const amount = parseInt(value, 10);
  const currency = crypto || "BTC";        // absent means BTC

  if (confirmations === 0 && rbf !== undefined) return;   // replaceable, ignore
  if (confirmations < 2) {
    await markPaymentDetected(addr, txid, confirmations);  // UI only, no fulfilment
    return;
  }

  // 4. Idempotency: a unique index on (txid, addr) makes replays a no-op.
  const claimed = await db.payments.insertIfAbsent({ txid, addr, amount, currency });
  if (!claimed) return;                    // already processed this payment

  const order = await db.orders.findByAddress(addr);
  if (!order) {
    await alertUnmatchedPayment({ addr, txid, amount });   // money received, no order
    return;
  }
  if (order.status === "paid") return;

  const decimals = currency === "USDT" ? 1_000_000 : 100_000_000;
  const tolerance = Math.floor(order.expected_amount * 0.01);

  if (amount >= order.expected_amount - tolerance) {
    await fulfillOrder(order.id, { txid, amount, currency });
  } else {
    await flagUnderpayment(order.id, amount, order.expected_amount);
  }
});

function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  // The length check is mandatory, not an optimisation: crypto.timingSafeEqual
  // THROWS RangeError on unequal lengths. Calling it directly on a caller-supplied
  // secret turns a wrong-length secret into an uncaught 500 instead of a 403.
  return x.length === y.length && require("node:crypto").timingSafeEqual(x, y);
}
```

Do not inline `crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expected))` at the call site. It reads as equivalent and is not — an attacker probing with a short secret crashes the handler.

### Why respond before doing the work

The retry policy keys off the HTTP status. A handler that fulfills an order, sends an email, and calls a shipping API before returning 200 can exceed the delivery timeout, get retried, and do all of it a second time. Acknowledge first, then process — and rely on the idempotency key rather than on speed.

---

## Idempotency in practice

Enforce it in the database, not in application logic. A unique constraint on `(txid, addr)` in a `payments` table makes concurrent duplicate callbacks collapse into one insert, which no amount of `if (alreadyProcessed)` checking can guarantee under concurrency.

```sql
CREATE TABLE payments (
  txid      TEXT NOT NULL,
  addr      TEXT NOT NULL,
  amount    BIGINT NOT NULL,   -- integer units; never FLOAT for money
  currency  TEXT NOT NULL,
  seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (txid, addr)
);
```

Note the composite key rather than `txid` alone: one transaction can pay several of the merchant's addresses in a single batch, producing distinct legitimate callbacks that share a `txid`.

---

## Local development

The callback URL must be reachable from the public internet. For local work, tunnel it:

```bash
ngrok http 3000
# then set the store's callback URL to
# https://<id>.ngrok.io/api/payment-callback?secret=RANDOM_SECRET
```

Use test mode to fire real callbacks without spending crypto — see `testing-and-go-live`. Every attempt, with the HTTP status returned, is logged at **Log/Test Bench** in the dashboard, which is the first place to look when callbacks appear to be missing.

---

## Debugging

| Symptom | Likely cause |
|---|---|
| No callbacks at all | Handler is `POST`; callback is `GET` |
| No callbacks at all | Callback URL not publicly reachable, or not set on the store |
| No USDT callbacks | `/monitor_tx` was never called with the `txhash` |
| Callback logs show non-200 | Handler threw, or the secret check rejected it |
| Same order fulfilled 2–3 times | No idempotency key; one callback per status was treated as one payment each |
| Payment arrives, no order matches | Address was not persisted against the order before checkout rendered |
| Order marked paid but funds reversed | Fulfilled at `status < 2`, or an `rbf` callback was accepted |

---

## Checklist

- [ ] Route is `GET`, reads `req.query`
- [ ] Secret compared in constant time, on every request
- [ ] 200 returned before doing any work
- [ ] `status >= 2` required before fulfilment
- [ ] `rbf` presence rejected on `status = 0`
- [ ] Missing `crypto` treated as BTC
- [ ] Unique `(txid, addr)` constraint enforcing idempotency
- [ ] Unmatched-address payments alert a human rather than failing silently
