---
name: payment-monitoring
description: Guide for real-time Blockonomics payment detection using the WebSocket endpoint for Bitcoin and the monitor_tx endpoint for USDT, including reconnection handling and why monitoring is never proof of payment.
---

# Real-Time Payment Monitoring

How the checkout page learns that money has arrived, before confirmations complete.

## When to use this skill

- Showing a live "payment detected" state on a checkout page
- Subscribing to Bitcoin payments over WebSocket
- Registering a USDT transaction for tracking
- Deciding what monitoring may and may not be used for

---

## The rule that governs this whole skill

**Monitoring drives the UI. Callbacks drive fulfilment.**

The WebSocket reports what is in the mempool. Mempool transactions can be replaced, evicted, or double-spent. Delivering a product on a WebSocket event is giving goods away against a promise the sender can still retract. Every fulfilment decision belongs in the callback handler at `status >= 2` — see `callback-handling`.

Monitoring is worth building anyway: without it the customer stares at a static page for ten minutes wondering whether their payment landed, and support tickets follow.

---

## Bitcoin: WebSocket

```
wss://www.blockonomics.co/payment/{address}
```

One connection tracks one address. On connect, the API attaches to the most recent payment to that address and follows it through confirmation, so a client that connects after the transaction was broadcast still receives its state.

```javascript
const ws = new WebSocket(`wss://www.blockonomics.co/payment/${address}`);

ws.onmessage = (event) => {
  const { status, value, txid, timestamp } = JSON.parse(event.data);
  // status: 0 unconfirmed, 1 one confirmation, 2 confirmed
  // value:  satoshis (integer)
};
```

### Message format

```json
{
  "status": 0,
  "timestamp": 1470371749,
  "value": 167377096,
  "txid": "aed36253434b90e45ded86ccf1729f5d2acd78bd7665c54e62d5000035a8f6d8"
}
```

- `status` — `0` unconfirmed, `1` partially confirmed, `2` confirmed
- `timestamp` — Unix seconds
- `value` — satoshis; `value / 1e8` for BTC
- `txid` — transaction ID

Expect **multiple messages** for one payment as it progresses `0 → 1 → 2`.

### Production client

A bare `new WebSocket(...)` drops silently on network changes, laptop sleep, and proxy timeouts, leaving a checkout page that looks live but receives nothing. Reconnect with backoff:

```javascript
function watchPayment(address, onUpdate) {
  let ws;
  let attempt = 0;
  let closed = false;

  const connect = () => {
    ws = new WebSocket(`wss://www.blockonomics.co/payment/${address}`);

    ws.onopen = () => { attempt = 0; };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onUpdate(data);
        // Confirmed: the server has nothing further to send for this payment.
        if (data.status >= 2) { closed = true; ws.close(); }
      } catch {
        // Ignore unparseable frames rather than tearing down the connection.
      }
    };

    ws.onclose = () => {
      if (closed) return;
      // Capped exponential backoff: 1s, 2s, 4s … 30s max.
      const delay = Math.min(1000 * 2 ** attempt++, 30_000);
      setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();   // let onclose own the retry path
  };

  connect();
  return () => { closed = true; ws?.close(); };   // call on unmount
}
```

Return a teardown function and call it when the component unmounts. Checkout pages that mount the socket without cleanup leak a connection per render.

### Browser-side, so treat the data as untrusted

The WebSocket runs in the customer's browser and anything the page does with it is under their control. Never let a client-side message mark an order paid through an unauthenticated endpoint — the server learns about payment from the callback, and only from the callback.

---

## USDT: monitor_tx

USDT has no per-order address; `/new_address?crypto=USDT` returns the merchant's single static EVM address every time. Blockonomics therefore cannot attribute an incoming transfer to a store on its own, and **no USDT callback is sent until the transaction hash is registered**.

```
POST https://www.blockonomics.co/api/monitor_tx
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

All four fields are required:

| Field | Type | Description |
|---|---|---|
| `txhash` | string | The transaction hash to monitor |
| `crypto` | string | `USDT` |
| `match_callback` | string | Substring of the store's callback URL, selecting the store |
| `testnet` | integer | `0` = Ethereum mainnet, `1` = Sepolia testnet |

```javascript
// Server-side. The txhash arrives from the Web3 component's onTxnSubmitted.
app.post("/api/payments/confirm", requireSession, async (req, res) => {
  const { txhash, orderId } = req.body;

  const order = await db.orders.get(orderId);
  await db.orders.update(orderId, { txhash });   // persist before registering

  const r = await fetch("https://www.blockonomics.co/api/monitor_tx", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.BLOCKONOMICS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      txhash,
      crypto: "USDT",
      match_callback: process.env.CALLBACK_MATCH,
      testnet: 0,
    }),
  });

  if (!r.ok) {
    // Registration failed: no callback will ever arrive for this payment. Do not
    // swallow this - the customer has already sent funds on-chain.
    await alertOps("monitor_tx registration failed", { orderId, txhash });
    return res.status(502).json({ error: "monitoring_failed" });
  }

  res.json(await r.json());
});
```

The response reports the transaction's current status: `-1` reverted, `0` unconfirmed, `1` one confirmation, `2` confirmed. Note `-1` — a reverted ERC-20 transfer has no BTC equivalent and must be handled explicitly.

### Make registration reliable

The customer's funds are already committed by the time `onTxnSubmitted` fires. If `/monitor_tx` fails, the payment is invisible to the system forever. Persist the `txhash` against the order *before* calling, and retry from a durable queue rather than only from the browser request that triggered it.

---

## Choosing an approach

| Need | Use |
|---|---|
| Live checkout UI, BTC | WebSocket |
| Live checkout UI, USDT | Web3 component events (see `web3-usdt-component`) |
| USDT callbacks at all | `/monitor_tx` — mandatory, server-side |
| Fulfilment | Callbacks only (`callback-handling`) |
| Reconciliation / back-office | `GET /v2/payments` (see `blockchain-search`) |

Do not poll `/balance` or `/v2/payments` on a timer as a substitute for callbacks. It is slower, it burns rate limit, and it still cannot tell which order a payment belongs to without the address mapping the callback already gives.
