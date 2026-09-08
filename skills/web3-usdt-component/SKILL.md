---
name: web3-usdt-component
description: Guide for embedding the Blockonomics Web3 USDT component so customers can pay USDT from MetaMask or another browser wallet, including the onTxnSubmitted handler and mandatory server-side transaction registration.
---

# Web3 USDT Component

A drop-in custom element that handles wallet connection, network validation, and ERC-20 transfer signing on a USDT checkout page.

## When to use this skill

- Accepting USDT (ERC-20) from browser wallets such as MetaMask
- Embedding the payment element on a checkout page
- Wiring the transaction hash back to the server
- Debugging a USDT payment that never produced a callback

Read `receiving-payments` for the surrounding flow.

---

## Embed

```html
<script src="https://blockonomics.co/js/web3-payment.js"></script>

<web3-payment
  id="web3_payment"
  order_amount="10"
  receive_address="YOUR_USDT_RECEIVE_ADDRESS"
></web3-payment>
```

| Attribute | Description |
|---|---|
| `order_amount` | Amount of USDT the customer must pay |
| `receive_address` | The merchant's USDT (ERC-20) receiving address |

`receive_address` is the address returned by `POST /new_address?crypto=USDT`. It is the merchant's single static USDT address — the same value on every order.

Render both attributes from server-side order state. Reading `order_amount` from a query string or client-side cart lets a customer set their own price by editing the URL.

---

## Handle submission

When the customer approves the transfer in their wallet, the component fires `onTxnSubmitted`:

```javascript
const web3Payment = document.getElementById("web3_payment");

web3Payment.onTxnSubmitted = function (result) {
  const { crypto, txhash } = result;

  fetch("/api/payments/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ txhash, crypto, orderId: ORDER_ID }),
  });
};
```

It is assigned as a property on the element, not added with `addEventListener`. Assign it after the element exists in the DOM and after the component script has loaded.

---

## Register the transaction server-side — mandatory

`onTxnSubmitted` means the customer signed and broadcast. It does **not** mean the payment is confirmed, and on its own it produces no callback.

The server must call `POST /monitor_tx` with that `txhash`, or Blockonomics never associates the transfer with the store and **no callback is ever sent**. Because the USDT receive address is static and shared across all orders, the hash is the only thing that identifies this payment.

```javascript
app.post("/api/payments/confirm", requireSession, async (req, res) => {
  const { txhash, orderId } = req.body;

  const order = await db.orders.get(orderId);
  if (!order || order.user_id !== req.session.userId) return res.sendStatus(403);

  // Persist first: if the API call fails, the hash is still recoverable and the
  // registration can be retried. The customer's funds are already committed.
  await db.orders.update(orderId, { txhash, status: "awaiting_confirmation" });

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
    await enqueueRetry("monitor_tx", { orderId, txhash });
    await alertOps("monitor_tx failed", { orderId, txhash });
    return res.status(502).json({ error: "monitoring_failed" });
  }

  res.json(await r.json());
});
```

Retry from a durable queue, not only from this request. If the browser closes between the wallet signature and a successful registration, the payment is on-chain and invisible to the application until someone reconciles it by hand.

---

## Fulfilment

Mark the order paid from the **callback**, at `status >= 2` — never from `onTxnSubmitted`. A broadcast ERC-20 transfer can still revert; `/monitor_tx` reports status `-1` for exactly that case.

USDT callback values are in **base units with 6 decimals**, not satoshis:

```javascript
const usdt = parseInt(value, 10) / 1_000_000;
```

The callback carries `crypto=USDT`. An absent `crypto` parameter means BTC. See `callback-handling`.

---

## Testing

Test mode supplies a simulated Ethereum wallet in the browser — no real wallet, no real funds. Select **Pay with USDT**, click **Connect Wallet**, and a Test Ethereum Wallet popup appears. USDT callbacks fire within about a minute. Set `testnet: 1` on `/monitor_tx` when working against Sepolia. See `testing-and-go-live`.

---

## Failure modes

| Symptom | Cause |
|---|---|
| No callback after a visibly successful transfer | `/monitor_tx` was never called, or failed silently |
| `onTxnSubmitted` never fires | Handler assigned before the component script loaded, or via `addEventListener` |
| Customer pays the wrong amount | `order_amount` sourced from client-side state |
| Callback arrives with a tiny value | Base units read as whole USDT — divide by 1e6 |
| Order paid, then funds absent | Fulfilled on `onTxnSubmitted`; the transaction later reverted (`status = -1`) |
| Nothing happens on Connect Wallet | No injected provider in the browser, or the wallet is on the wrong network |
