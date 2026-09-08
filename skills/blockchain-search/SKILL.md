---
name: blockchain-search
description: Guide for the Blockonomics read endpoints — address and xpub balances, transaction history, transaction details, payment history, order lookup, and OP_RETURN search.
---

# Blockchain Search and Reporting

Read-only endpoints for balances, history, and reconciliation. None of them move funds.

## When to use this skill

- Looking up a balance for an address or xPub
- Fetching transaction history for a wallet
- Inspecting a specific transaction
- Building a back-office payments or reconciliation view
- Searching OP_RETURN payloads

Base URL `https://www.blockonomics.co/api`. All values are satoshis unless stated otherwise.

---

## Balances

```
GET /balance?addr=<addresses>
Authorization: Bearer YOUR_API_KEY
```

`addr` (required) is a **whitespace-separated** list of addresses and/or xPubs; `+` or `%20` also works as the separator. Returns confirmed and unconfirmed balances in satoshis.

```bash
curl "https://www.blockonomics.co/api/balance?addr=1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" \
  -H "Authorization: Bearer $BLOCKONOMICS_API_KEY"
```

Batch addresses into one call rather than looping — that is what the whitespace-separated list is for.

Passing an xPub returns the aggregate across its derived addresses, which is the right way to ask "how much has this wallet received in total".

**Do not poll this to detect payments.** It cannot tell which order a payment belongs to, it lags the mempool, and it wastes rate limit. Payment detection is the WebSocket (UI) and the callback (truth) — see `payment-monitoring`.

---

## Transaction history

```
GET /searchhistory?addr=<addresses>&fiat_currency=USD
Authorization: Bearer YOUR_API_KEY
```

| Param | Required | Description |
|---|---|---|
| `addr` | yes | Space-separated addresses and/or xPubs, treated as one wallet |
| `fiat_currency` | no | When set, confirmed transactions include the fiat value at transaction time |

Returns up to **200** transactions, newest first, split into two arrays:

- `pending` — unconfirmed (fewer than 2 confirmations)
- `history` — confirmed (2 or more)

The 200-item ceiling is a hard cap with no pagination parameter, so this endpoint cannot enumerate the full history of a busy wallet. For accounting, persist payments as their callbacks arrive and treat this endpoint as a cross-check rather than the system of record.

`fiat_currency` gives the value **at transaction time**, not today's value — that is what belongs in a ledger, and recomputing it later from a current price is wrong.

---

## Transaction details

```
GET /tx_detail?txid=<txid>
Authorization: Bearer YOUR_API_KEY
```

Returns inputs, outputs, fee, size, and RBF status for a Bitcoin transaction.

Useful when a callback arrived with `status = 0` and the RBF flag needs verifying independently, or when investigating an amount that does not match the order.

---

## Payment history

```
GET /v2/payments
Authorization: Bearer YOUR_API_KEY
```

Confirmed payments received across all stores, newest first.

| Param | Description |
|---|---|
| `limit` | 1–200, defaults to 200 |
| `timeframe` | `1W`, `2W`, `1M`, `3M` … |
| `crypto` | Filter by cryptocurrency; omit for all |
| `store_name` | Partial, case-insensitive store name filter |
| `currency` | Fiat code (e.g. `USD`); adds a `fiat_value` field to each payment |

This is the merchant-facing view and the right endpoint for a back-office dashboard or a reconciliation job. Unlike `/balance` it is scoped to actual store payments rather than raw chain activity.

It is capped at 200 with no cursor, so windowing must be done with `timeframe`. A nightly reconciliation should pull a short window frequently rather than trying to page through history.

---

## Payment button orders

```
GET /merchant_orders?limit=<n>
GET /merchant_order/{uuid}
Authorization: Bearer YOUR_API_KEY
```

Orders created through Blockonomics payment buttons and hosted checkouts. These are distinct from API-generated payments — an integration that builds its own checkout with `/new_address` will not find its orders here.

---

## OP_RETURN search

```
GET /op_return?q=<string>&limit=<n>
```

Public, no authentication. Searches Bitcoin transactions by OP_RETURN payload and returns matching transaction IDs, timestamps, and embedded data.

Unrelated to payment processing — it is a chain-data utility for provenance, timestamping, and protocol research.

---

## Choosing an endpoint

| Question | Endpoint |
|---|---|
| Did this order get paid? | Neither — use the callback |
| How much has this wallet received? | `GET /balance` with the xPub |
| What did this wallet do recently? | `GET /searchhistory` |
| What are the mechanics of this transaction? | `GET /tx_detail` |
| What has the merchant been paid across stores? | `GET /v2/payments` |
| Details of a payment-button order | `GET /merchant_order/{uuid}` |
| Find data embedded in the chain | `GET /op_return` |

---

## Notes

- Every read endpoint except `/op_return` requires the Bearer key, and that key is account-wide. Never expose these behind an unauthenticated route — `/balance` and `/v2/payments` disclose the merchant's revenue.
- Values are integer satoshis (or USDT base units, 6 decimals). Divide only for display, and never hold money in a float.
- Both list endpoints cap at 200 with no cursor. Anything needing complete history must be built from stored callbacks.
