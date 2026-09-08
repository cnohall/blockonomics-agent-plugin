---
name: wallet-and-store-setup
description: Guide for creating and managing Blockonomics wallets and stores over the v2 API, covering xPub attachment, callback URLs, wallet-to-store binding, and the gap limit.
---

# Wallet and Store Setup

Wallets and stores are the two objects every payment depends on. A wallet says where funds go; a store says where callbacks go and which wallet to derive from.

## When to use this skill

- Creating a wallet or store programmatically instead of through the dashboard
- Attaching or detaching wallets from stores
- Changing a callback URL
- Onboarding merchants in a multi-tenant application
- Diagnosing why address generation fails

---

## The object model

```
Account
 └── Wallet   (BTC xPub, or USDT EVM address)   -- where money lands
 └── Store    (name + callback URL)             -- where notifications go
      └── attached wallet(s)                    -- which wallet derives addresses
```

`POST /new_address` picks a store by substring-matching `match_callback` against store callback URLs, then derives from that store's attached wallet. Both objects must exist and be linked, or address generation fails.

All endpoints below require `Authorization: Bearer YOUR_API_KEY`.

---

## Wallets

### List

```
GET /v2/wallets?balance=true
```

`balance` (boolean, optional) includes balance information. Omit it on hot paths — computing balances across a large xPub is significantly slower than listing metadata.

### Create

```
POST /v2/wallets
```

| Field | Required | Description |
|---|---|---|
| `address` | yes | BTC: an **xPub**. USDT: an EVM address (`0x…`). |
| `crypto` | yes | `BTC` or `USDT`. |
| `name` | no | Label for identification. |

```bash
curl -X POST "https://www.blockonomics.co/api/v2/wallets" \
  -H "Authorization: Bearer $BLOCKONOMICS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Main BTC","address":"xpub6C…","crypto":"BTC"}'
```

**Send an xPub, never a single address, for BTC.** A plain address makes every order reuse the same address, which destroys per-order attribution — several customers pay the same address and the callbacks cannot be told apart. The xPub lets Blockonomics derive a fresh address per order from a key it cannot spend from.

**Never send a private key, WIF, or seed phrase.** The `address` field takes public key material only. An xPub allows deriving receive addresses and nothing else.

### Get, update, delete

```
GET    /v2/wallets/{id}?balance=true
POST   /v2/wallets/{id}      { "name": "…", "gap_limit": 20 }
DELETE /v2/wallets/{id}
```

Note that update is `POST`, not `PUT` or `PATCH`.

#### gap_limit

The number of consecutive unused addresses to scan before treating the wallet as inactive. **Leave it alone unless there is a specific reason.**

Every `/new_address` call advances the derivation index whether or not the address is ever paid. Abandoned checkouts therefore create gaps. If the run of unpaid addresses exceeds the gap limit, the merchant's own wallet software stops scanning and incoming funds stop appearing — the money is on-chain and safe, but invisible until the limit is raised and the wallet rescanned.

The durable fix is to stop burning addresses: generate one address per order and reuse it on reload (see `receiving-payments`), rather than raising the limit indefinitely.

Deleting a wallet detaches it from Blockonomics only. Funds are in the merchant's own wallet throughout and are unaffected.

---

## Stores

### List

```
GET /v2/stores?wallets=true
```

### Create

```
POST /v2/stores
```

| Field | Required | Description |
|---|---|---|
| `http_callback` | yes | The callback URL |
| `name` | no | Store name |

```bash
curl -X POST "https://www.blockonomics.co/api/v2/stores" \
  -H "Authorization: Bearer $BLOCKONOMICS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Shop","http_callback":"https://acme.com/api/payment-callback?secret=RANDOM_SECRET"}'
```

The callback URL does double duty — it receives notifications, and its substring is how `/new_address` and `/monitor_tx` route to this store. Include the shared secret as a query parameter here; that is the only authentication callbacks carry (see `callback-handling`).

**Make callback URLs distinguishable across stores.** `match_callback` is a substring match. Two stores at `shop.acme.com/cb` and `shop.acme.com/cb2` are ambiguous: matching on `shop.acme.com/cb` can resolve to either, and addresses then derive from the wrong wallet. Give each store a distinct, unambiguous path segment or subdomain.

### Get, update, delete

```
GET    /v2/stores/{id}
POST   /v2/stores/{id}      { "name": "…", "http_callback": "…" }
DELETE /v2/stores/{id}
```

Rotating the callback secret means updating `http_callback` here and the handler's expected secret together. Accept both values for a short window, or in-flight callbacks retrying against the old secret will 403 and be lost.

### Store wallets

```
GET    /v2/stores/{id}/wallets
POST   /v2/stores/{id}/wallets           { "wallet_id": 123 }
DELETE /v2/stores/{id}/wallets/{wallet_id}
```

Attach one wallet per cryptocurrency the store accepts — a BTC wallet for Bitcoin, a USDT wallet for USDT.

---

## Provisioning a merchant end to end

```javascript
const API = "https://www.blockonomics.co/api";
const headers = {
  Authorization: `Bearer ${process.env.BLOCKONOMICS_API_KEY}`,
  "Content-Type": "application/json",
};

async function post(path, body) {
  const r = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function provisionMerchant({ name, xpub, callbackUrl }) {
  const wallet = await post("/v2/wallets", { name: `${name} BTC`, address: xpub, crypto: "BTC" });
  const store = await post("/v2/stores", { name, http_callback: callbackUrl });
  await post(`/v2/stores/${store.id}/wallets`, { wallet_id: wallet.id });
  return { walletId: wallet.id, storeId: store.id };
}
```

The three calls are not atomic. A failure after the wallet is created leaves an orphan; on retry, list existing wallets and stores first rather than blindly creating duplicates, since neither endpoint deduplicates.

---

## Multi-tenant note

The API key authenticates the **account**, not a store. One key can read every store's payment history and generate addresses against every attached wallet.

A platform onboarding third-party merchants under a single Blockonomics account is therefore holding one credential with full authority over all of them. Either give each merchant their own Blockonomics account and key, or keep the key strictly server-side behind authorization checks that verify the requesting tenant owns the store before any call is made. Never let a tenant-supplied value flow unchecked into `match_callback` — that is how one merchant's checkout starts deriving addresses from another merchant's wallet.

---

## Why address generation fails

| Symptom | Cause |
|---|---|
| `/new_address` errors or returns nothing | No wallet attached to the matched store |
| Address derives from the wrong wallet | `match_callback` ambiguous across stores |
| Same address returned every time (BTC) | Wallet registered with a plain address instead of an xPub |
| Same address every time (USDT) | Expected — USDT uses one static address |
| Funds arrive but merchant wallet shows nothing | Derivation ran past the gap limit; rescan and stop burning addresses |
| 401 on every call | Key absent, or sent as something other than `Authorization: Bearer …` |
