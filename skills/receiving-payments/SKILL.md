---
name: receiving-payments
description: Complete guide for accepting BTC and USDT payments with Blockonomics, from generating a payment address and converting the fiat total through to a confirmed callback.
---

# Receiving Payments with Blockonomics

The end-to-end merchant flow: generate an address, quote a price, show checkout, detect the payment, fulfill on confirmation.

## When to use this skill

- Adding a crypto checkout to a website or application
- Generating a payment address for an order
- Converting a fiat cart total into BTC or USDT
- Wiring the checkout page to real-time payment detection
- Deciding when it is safe to fulfill an order

Read `blockonomics-best-practices` first for the base URL, authentication, and unit conventions.

---

## Prerequisites

A wallet and a store must exist, with a callback URL set on the store. Address generation fails without them. See `wallet-and-store-setup`.

---

## Step 1: Generate a payment address

`POST /new_address` returns a unique address for this order.

```
POST https://www.blockonomics.co/api/new_address
Authorization: Bearer YOUR_API_KEY
```

| Query param | Required | Description |
|---|---|---|
| `match_callback` | recommended | Substring of the target store's callback URL. Selects which store this address belongs to. |
| `crypto` | no | `BTC` (default) or `USDT`. |
| `reset` | no | BTC only. `0` (default) generates a new address; `1` returns the last generated address again. |

```bash
curl -X POST "https://www.blockonomics.co/api/new_address?match_callback=yoursite.com&crypto=BTC" \
  -H "Authorization: Bearer $BLOCKONOMICS_API_KEY"
```

### match_callback selects the store

An account with more than one store must send `match_callback`, or the address may be derived from the wrong store's wallet — money then arrives in a wallet the order logic is not watching. Pass a substring specific enough to be unambiguous across every store's callback URL on the account.

### reset is not a retry flag

`reset=1` returns the **previously generated** address instead of deriving a new one. It exists for recovering from a failed checkout render, not for retries in a loop. Calling `/new_address` repeatedly with the default `reset=0` burns a fresh address from the xPub each time, which pushes the wallet's derivation index forward and can eventually exceed the gap limit, at which point the merchant's wallet software stops detecting incoming funds.

**Call it once per order, and persist the result.** If the customer reloads the checkout page, serve the stored address; do not call the endpoint again.

### USDT returns a static address

For `crypto=USDT` the same EVM address is returned every time — it is the merchant's wallet address, not a derived one. Payments therefore cannot be distinguished by address, which is why USDT requires the explicit `/monitor_tx` registration in step 4.

---

## Step 2: Quote the price

`GET /price` converts fiat to crypto. Public, no authentication.

| Query param | Required | Description |
|---|---|---|
| `currency` | yes | Fiat currency code, e.g. `USD`. |
| `crypto` | no | Crypto code, e.g. `BTC` or `USDT`. |

```bash
curl "https://www.blockonomics.co/api/price?crypto=BTC&currency=USD"
```

It returns the price of **1 unit** of the crypto in that fiat currency. Divide, do not multiply:

```javascript
const { price } = await getPrice("BTC", "USD");
const btcAmount = fiatTotal / price;
const satoshis = Math.round(btcAmount * 1e8);   // store this, compare against this
```

Supported fiat codes: https://www.blockonomics.co/api/currencies

**Quote once and store it with the order.** Re-quoting on every page render means the amount changes under the customer while they are paying, and the payment then reconciles as an underpayment. Store `satoshis` plus a `quote_expires_at` timestamp (10–15 minutes is typical) and re-quote only after expiry, on an explicit customer action.

---

## Step 3: Render checkout

Show the address, the exact crypto amount, and a QR code. A BIP21 URI pre-fills both fields in the customer's wallet app:

```javascript
const uri = `bitcoin:${address}?amount=${btcAmount.toFixed(8)}`;
```

Persist before rendering:

```javascript
await db.orders.update(orderId, {
  payment_address: address,      // the callback's only join key
  expected_satoshis: satoshis,
  quote_expires_at: Date.now() + 15 * 60 * 1000,
  status: "awaiting_payment",
});
```

The address → order mapping must be committed before the page is shown. A customer can pay within seconds, and the callback will arrive with nothing but `addr` to identify the order.

---

## Step 4: Monitor

### BTC

Open a WebSocket from the checkout page for instant feedback:

```
wss://www.blockonomics.co/payment/{address}
```

See the `payment-monitoring` skill.

### USDT

Embed the Web3 USDT component (see `web3-usdt-component`). When the customer signs, it fires `onTxnSubmitted` with a `txhash`. The server must then register that hash for tracking:

```bash
curl -X POST "https://www.blockonomics.co/api/monitor_tx" \
  -H "Authorization: Bearer $BLOCKONOMICS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"txhash":"0xabc…","crypto":"USDT","match_callback":"yoursite.com","testnet":0}'
```

All four body fields are required. `testnet`: `0` = Ethereum mainnet, `1` = Sepolia.

**Without this call, no USDT callback is ever sent.** Because the USDT receive address is static, Blockonomics has no way to associate an incoming transfer with a store until the hash is registered. This is the single most common USDT integration failure.

Register it server-side from the `txhash` the component reports. Do not skip it because the transfer already appeared on a block explorer.

---

## Step 5: Fulfill on callback

Blockonomics sends an HTTP `GET` to the store's callback URL as confirmations accrue. Fulfill at `status >= 2`. Full handler, verification, and idempotency rules are in the `callback-handling` skill.

```
status 0  -> unconfirmed, in mempool     -> show "payment detected"
status 1  -> 1 confirmation              -> still waiting
status 2  -> 2+ confirmations, final     -> mark paid, deliver
```

**Never fulfill from the WebSocket or from `onTxnSubmitted`.** Both fire before the transaction is settled, and both can fire for a transaction that never confirms.

---

## Handling under- and overpayment

Blockonomics reports what arrived. It does not decide whether that satisfies the order. Compare in integers, against a policy the business has chosen:

```javascript
const received = parseInt(value, 10);           // satoshis
const expected = order.expected_satoshis;
const tolerance = Math.floor(expected * 0.01);  // 1% - a business decision, not an API default

if (received >= expected - tolerance) {
  await fulfill(order);
} else {
  await flagUnderpayment(order, received, expected);   // partial payment: needs a human or a top-up flow
}
```

A tolerance is genuinely needed: customers pay from wallets that deduct the network fee from the sent amount, and the price moves between quote and broadcast.

Overpayment is also real. Decide up front whether to fulfill and refund the difference, fulfill and credit it, or hold for review. There is no refund endpoint — a refund is an on-chain send from the merchant's own wallet.

---

## Full checkout example

```javascript
const API = "https://www.blockonomics.co/api";
const auth = { Authorization: `Bearer ${process.env.BLOCKONOMICS_API_KEY}` };

async function createCryptoCheckout(orderId, fiatTotal, currency = "USD", crypto = "BTC") {
  const order = await db.orders.get(orderId);

  // Idempotent: never burn a second address for an order that already has one.
  if (order.payment_address) return order;

  const addrRes = await fetch(
    `${API}/new_address?match_callback=${encodeURIComponent(process.env.CALLBACK_MATCH)}&crypto=${crypto}`,
    { method: "POST", headers: auth },
  );
  if (!addrRes.ok) throw new Error(`new_address failed: ${addrRes.status}`);
  const { address } = await addrRes.json();

  const priceRes = await fetch(`${API}/price?crypto=${crypto}&currency=${currency}`);
  const { price } = await priceRes.json();

  const decimals = crypto === "BTC" ? 1e8 : 1e6;
  const expected = Math.round((fiatTotal / price) * decimals);

  return db.orders.update(orderId, {
    payment_address: address,
    expected_amount: expected,
    crypto,
    quote_expires_at: Date.now() + 15 * 60 * 1000,
    status: "awaiting_payment",
  });
}
```

---

## Checklist

- [ ] `match_callback` passed on every `/new_address` call
- [ ] One address per order, persisted, never regenerated on reload
- [ ] Quote stored with the order, not recomputed per render
- [ ] Amounts held as integers (satoshis / USDT base units)
- [ ] USDT: `/monitor_tx` called server-side with the `txhash`
- [ ] Fulfillment gated on callback `status >= 2`, never on WebSocket
- [ ] Underpayment tolerance and overpayment policy decided explicitly
