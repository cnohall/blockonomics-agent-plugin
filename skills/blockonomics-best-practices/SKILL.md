---
name: blockonomics-best-practices
description: Guide for starting a Blockonomics integration, covering the base URL, API key authentication, the non-custodial model, and the canonical checkout-to-callback payment architecture.
---

# Blockonomics Integration Guide

This skill covers the foundational concepts for Blockonomics. Use it when starting a new integration, before choosing endpoints, or when reasoning about the overall payment flow.

## When to use this skill

- You are adding Bitcoin or USDT payments to an application and need the architecture
- You need to know how authentication works and where the API key comes from
- You are deciding what your server must build versus what Blockonomics handles
- You need the canonical order of API calls for a payment
- Another Blockonomics skill referred you here for setup context

---

## What Blockonomics is

Blockonomics is a **non-custodial** Bitcoin and USDT payment processor. Funds move directly from the customer to the merchant's own wallet on-chain. Blockonomics never holds, forwards, or settles funds, and cannot reverse a payment.

Two consequences shape every integration:

- **The merchant supplies the wallet.** For BTC that is an xPub (extended public key); Blockonomics derives a fresh receive address from it per order. For USDT it is a plain EVM address. Blockonomics holds only public keys, never private keys or seed phrases.
- **There is no refund API.** Refunds are an on-chain send the merchant performs from their own wallet. Do not look for a refund endpoint; it does not exist.

Blockonomics is not a Merchant of Record. It does not calculate or remit sales tax, and it does not handle disputes. Chargebacks do not exist on-chain.

---

## Environment setup

### Base URL

One base URL, for everything, live and test alike:

```
https://www.blockonomics.co/api
```

There is **no separate sandbox host**. Test mode is a per-store toggle in the dashboard, not a different base URL and not a different API key. Do not construct `api.blockonomics.co`, `test.blockonomics.co`, or a `/v1/` prefix — none of them exist. See the `testing-and-go-live` skill.

Note that some endpoints are versioned (`/v2/wallets`, `/v2/stores`, `/v2/payments`) and some are not (`/new_address`, `/price`, `/monitor_tx`, `/balance`). This is a property of the API, not a mistake. Use each path exactly as documented.

### Authentication

Bearer token in the `Authorization` header:

```
Authorization: Bearer YOUR_API_KEY
```

The key is found in the dashboard under **Stores**. It is a long-lived credential scoped to the whole account, not to a single store.

```bash
curl "https://www.blockonomics.co/api/price?crypto=BTC&currency=USD"
# no auth needed - /price and /op_return are public

curl -X POST "https://www.blockonomics.co/api/new_address?match_callback=yoursite.com" \
  -H "Authorization: Bearer $BLOCKONOMICS_API_KEY"
```

Rules for handling the key:

- Server-side only. It can generate receive addresses and read payment history for every store on the account.
- Never ship it to a browser, a mobile binary, or a public repository. There is no publishable/restricted key variant to reach for.
- Read it from an environment variable (`BLOCKONOMICS_API_KEY`), never a literal in source.
- To rotate: dashboard → **Stores** → refresh icon. The new key is live immediately, so deploy it before discarding the old one.

### No official SDK

Blockonomics publishes no first-party client library. Call the REST API directly with the HTTP client already in the project (`fetch`, `requests`, `httpx`, Guzzle). **Do not invent an import** such as `blockonomics-sdk` or `@blockonomics/node` — if one appears in generated code, it was hallucinated. Any package on a registry under that name is third-party and unaffiliated.

---

## Prerequisites before any API call

Both must exist in the dashboard, or address generation fails:

1. **A wallet** — dashboard → **Wallets** → add. BTC takes an xPub; USDT takes an EVM (`0x…`) address.
2. **A store** — dashboard → **Stores** → add, attach the wallet, and set the **callback URL**.

The callback URL is not optional plumbing. It is how a payment becomes known to the application, and it is also the routing key: `/new_address` and `/monitor_tx` identify which store a request belongs to by substring-matching the `match_callback` parameter against it.

These can also be created over the API — see the `wallet-and-store-setup` skill.

---

## The canonical payment flow

Every payment, BTC or USDT, goes through three phases. Build all three; skipping any one produces an integration that appears to work in testing and loses orders in production.

```
1. CHECKOUT   POST /new_address   -> a unique address for this order
              GET  /price         -> fiat total converted to crypto
              persist: address -> order id

2. MONITOR    BTC:  WebSocket wss://www.blockonomics.co/payment/{address}
              USDT: Web3 component -> POST /monitor_tx with the txhash
              purpose: instant UX feedback ONLY

3. CALLBACK   Blockonomics -> HTTP GET your callback URL
              status >= 2  -> mark paid, fulfill
```

**Phase 2 is presentation. Phase 3 is truth.** The WebSocket sees a transaction the moment it hits the mempool, which is excellent for showing the customer a "payment detected" screen. It is not evidence of payment. An unconfirmed transaction can be replaced or dropped. Fulfill only from the callback, only at `status >= 2`.

### Persist the address-to-order mapping at checkout

The callback identifies the payment by `addr`. If the address was never stored against an order at checkout time, the callback arrives and there is nothing to reconcile it with, and the money is on-chain with no way to attribute it. Write the mapping in the same transaction that creates the order, before rendering the checkout page.

---

## Units

A recurring source of silent, expensive bugs. The API never sends decimal amounts.

| Currency | Callback / API unit | Convert to display |
|---|---|---|
| BTC | satoshis (integer) | `value / 100_000_000` |
| USDT | base units, 6 decimals (integer) | `value / 1_000_000` |

`GET /price` is the exception and returns a decimal fiat price for **1 unit** of the crypto.

Use integer arithmetic for money wherever the language allows it. Floating-point satoshi maths accumulates error, and Bitcoin amounts are exact integers by definition.

```javascript
// correct
const btc = Number(satoshis) / 1e8;              // display only
const expectedSats = Math.round(fiatTotal / btcPrice * 1e8);  // compare as integers

// wrong - never compare floats for payment sufficiency
if (btc === orderTotalBtc) { /* fails on rounding */ }
```

Compare with a tolerance, or better, compare integer satoshis with an explicit underpayment threshold the business has chosen.

---

## What you must build

Blockonomics handles address derivation, on-chain monitoring, confirmation tracking, and callback delivery with retries. The application is responsible for:

- Storing the address → order mapping
- Verifying the callback secret
- Idempotent callback processing (the same order is called back multiple times, once per status)
- Deciding the confirmation threshold (`status >= 2` is the default recommendation)
- Handling underpayment and overpayment — Blockonomics reports the amount received, it does not judge whether it satisfies the order
- Price-lock expiry: the quoted crypto amount is only valid for as long as the quote is held, typically 10–15 minutes

Addresses themselves **never expire**. A checkout countdown timer locks in the price, not the address; a customer paying an hour late still reaches a valid address and still triggers a callback.

---

## Where to go next

| Task | Skill |
|---|---|
| Build the checkout and take a payment | `receiving-payments` |
| Write the callback handler | `callback-handling` |
| Real-time payment detection | `payment-monitoring` |
| Create wallets and stores over the API | `wallet-and-store-setup` |
| Embed the USDT browser-wallet element | `web3-usdt-component` |
| Simulate payments without real funds | `testing-and-go-live` |
| Query balances, history, transactions | `blockchain-search` |

Full reference: https://developers.blockonomics.co/docs
