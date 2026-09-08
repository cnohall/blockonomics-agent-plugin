---
name: testing-and-go-live
description: Guide for simulating BTC and USDT payments with Blockonomics Test Mode, reading callback logs in the Test Bench, and the checks to complete before accepting real funds.
---

# Testing and Go-Live

Test Mode fires real callbacks against a real server without spending any crypto.

## When to use this skill

- Verifying a callback handler before taking real payments
- Reproducing the full status progression `0 → 1 → 2`
- Debugging callbacks that appear not to arrive
- Running the pre-launch check before going live

---

## How test mode works here

Test mode is a **per-store toggle in the dashboard**, not a separate environment.

There is no sandbox host, no test API key, and no `test_mode` request parameter. The base URL stays `https://www.blockonomics.co/api` and the API key stays the same. This differs from most payment processors — do not go looking for `test.blockonomics.co` or a `sk_test_` key prefix, and do not fabricate one in configuration.

Enable it: dashboard → **Stores** → open the store → toggle **Testmode** under Payment method → **Update Store**.

> Never send real BTC or USDT to a test address. Funds sent to one are lost.

Because the toggle is per-store, the cleanest setup is a **dedicated test store** with its own callback URL pointing at staging, left in test mode permanently, alongside the live store. Flipping a single production store back and forth risks leaving it in test mode while real customers check out.

---

## BTC: simulate a payment

1. Place a test order on the site. Checkout shows a **Test Bitcoin address** and a BTC amount.
2. Open **Log/Test Bench** in the dashboard (`https://www.blockonomics.co/dashboard#/test-bench`).
3. Under **Test Bitcoin Wallet**, confirm the **Pay to** address matches the checkout address.
4. Enter the exact BTC amount and click **Send**.

Callbacks then fire on a schedule:

| Status | Meaning | Delay |
|---|---|---|
| `0` | Unconfirmed (mempool) | Instant |
| `1` | 1 confirmation | ~5 min |
| `2` | Fully confirmed | ~10 min |

The delays are the point. Around ten minutes pass between order placement and the only callback that authorises fulfilment, which is exactly the window the UI has to handle gracefully. Sit through the full progression at least once rather than testing only the final callback.

Deliberately send a different amount too, to exercise the underpayment and overpayment paths.

---

## USDT: simulate a payment

1. Select **Pay with USDT** at checkout.
2. Click **Connect Wallet** — a **Test Ethereum Wallet** popup appears automatically. No real wallet needed.
3. **Connect** → **Pay [amount] USDT** → **Confirm**.

USDT callbacks fire within about a minute.

The server must still call `POST /monitor_tx` with the `txhash`, exactly as in production. Use `testnet: 1` when working against Sepolia. Skipping it is the most common reason a USDT test produces no callback at all.

---

## Callback logs

Every callback attempt is logged at **Log/Test Bench** → **Callback Logs**, with the HTTP status the server returned. A `200` at the end of the line means it was received correctly; anything else means Blockonomics will retry, up to 7 times with exponential backoff from 4 seconds.

This log is the first place to look when callbacks seem missing. It distinguishes the two very different failures:

- **No log entries** — Blockonomics never sent anything. The store's callback URL is wrong or unset, or (for USDT) `/monitor_tx` was never called.
- **Entries with non-200** — delivery worked and the handler rejected or crashed. Check the secret comparison and the handler's error log.

---

## Local development

The callback URL must be publicly reachable:

```bash
ngrok http 3000
# set the test store's callback to
# https://<id>.ngrok.io/api/payment-callback?secret=RANDOM_SECRET
```

Free tunnel URLs change on restart. Update the store's `http_callback` each time, or callbacks go to a dead host and burn all 7 retries.

---

## Pre-launch checklist

Payments are irreversible and non-custodial. There is no chargeback, no reversal, and no support path to recover funds sent to a wrong address. Work through this before the first real order.

**Wallet**
- [ ] Live wallet uses the merchant's own **xPub** — not an exchange deposit address, not an address from a wallet whose seed nobody holds
- [ ] A test receive was withdrawn successfully, proving control of the private keys
- [ ] The wallet is attached to the live store

**Callbacks**
- [ ] Handler is `GET`, reading query parameters
- [ ] Secret verified in constant time on every request
- [ ] Fulfilment gated on `status >= 2`
- [ ] `rbf` presence rejected on `status = 0`
- [ ] Idempotent via a unique `(txid, addr)` constraint
- [ ] Returns 200 before doing slow work
- [ ] Full `0 → 1 → 2` progression observed end to end in test mode

**Checkout**
- [ ] One address per order, persisted, reused on page reload
- [ ] Address → order mapping committed before the checkout page renders
- [ ] Amounts stored as integers (satoshis / USDT base units)
- [ ] Quote expiry handled with an explicit re-quote
- [ ] `match_callback` unambiguous across every store on the account

**Operations**
- [ ] `BLOCKONOMICS_API_KEY` in server-side environment config, absent from the repository and from any client bundle
- [ ] Underpayment and overpayment policies defined and implemented
- [ ] Unmatched-address payments raise an alert rather than failing silently
- [ ] `/monitor_tx` failures retry from a durable queue (USDT)
- [ ] Test mode **off** on the live store, and the live store's callback points at production

**Go live**
- [ ] First real payment made at small value, end to end, and the funds confirmed as spendable from the merchant's own wallet
