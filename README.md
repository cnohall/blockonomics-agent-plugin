# Blockonomics Agent Plugin

Agent skills for integrating [Blockonomics](https://www.blockonomics.co) — non-custodial Bitcoin and USDT payments — into any application, packaged for AI coding agents.

Built to the [Agent Plugins v1.0.0](https://agent-plugins.org/specification) spec, so one repository installs across Claude Code, Codex CLI, Cursor, VS Code / Copilot, and Kiro.

OpenCode is not supported yet: it loads plugins from an npm package rather than a repository, so it needs `@blockonomics/agent-plugin` published to npm. Gemini CLI has no agent-skill primitive at all, so it can only ever consume the MCP servers, not these skills.

## Why

Agents guess payment APIs. They invent SDK packages that do not exist, fabricate sandbox hostnames, fulfil orders on unconfirmed transactions, and forget that USDT payments need explicit registration before a callback is ever sent. Each of those produces code that looks correct and loses money.

These skills put the real API surface and the real failure modes into the agent's context before it writes the first line.

## Install

> **The commands below assume `github.com/blockonomics/blockonomics-agent-plugin`, which is where this plugin is meant to be served from.** Until that repository exists, they will not resolve — a marketplace or clone command is bound to the repo path. Development happens on a fork; only the canonical URL is documented, so nobody installs from a personal namespace by accident.
>
> If the canonical owner ever changes, edit `repository` in `plugin.json` and `package.json` and re-run `npm run build` — every generated manifest carries that URL. The plugin *name* (`blockonomics`) is independent of the path, so `claude plugins install blockonomics@blockonomics` is unaffected either way.

### Claude Code

```bash
claude plugins marketplace add blockonomics/blockonomics-agent-plugin
claude plugins install blockonomics@blockonomics
```

### Codex CLI

```bash
codex plugin marketplace add blockonomics/blockonomics-agent-plugin
# then use /plugins in the TUI; refresh with:
codex plugin marketplace upgrade blockonomics
```

### Cursor

```bash
git clone https://github.com/blockonomics/blockonomics-agent-plugin.git \
  ~/.cursor/plugins/local/blockonomics-agent-plugin
```

### VS Code / GitHub Copilot, Kiro

```bash
git clone https://github.com/blockonomics/blockonomics-agent-plugin.git
```

Register the clone in Chat → Plugins (VS Code) or the Powers panel (Kiro).

## Skills

| Skill | Covers |
|---|---|
| `blockonomics-best-practices` | Base URL, API key auth, non-custodial model, canonical payment flow, units |
| `receiving-payments` | Address generation, price quoting, checkout, fulfilment, under/overpayment |
| `callback-handling` | GET callback parameters, secret verification, RBF, idempotency, retries |
| `payment-monitoring` | BTC WebSocket, USDT `monitor_tx`, reconnection, what monitoring is not for |
| `wallet-and-store-setup` | `/v2/wallets` and `/v2/stores`, xPub attachment, gap limit, multi-tenant risks |
| `web3-usdt-component` | Embedding the browser-wallet element, `onTxnSubmitted`, server registration |
| `testing-and-go-live` | Test mode, Test Bench, callback logs, pre-launch checklist |
| `blockchain-search` | Balances, history, transaction details, payment history, OP_RETURN |

Start at `blockonomics-best-practices`; the others link back to it for setup context.

## MCP servers

None ship in v0.1.0. This release is skills only.

Two are staged in [`mcp.staged.json`](mcp.staged.json) — a documentation search server and a live API server. They are deliberately not declared yet: a manifest entry pointing at a server that is not serving surfaces to every user as a connection failure on every session.

They sit in a separate file because `mcp.schema.json` closes the root object to exactly `$schema` and `mcpServers`, so there is nowhere inside `mcp.json` to park an undeclared entry — not even under a `//` comment key. `mcp.staged.json` is not part of the spec and is not read by the build.

To release one, move its entry into `mcpServers` in `mcp.json`, drop it from `mcp.staged.json`, and run `npm run build`. The generator emits the `mcp-remote` stdio bridge in `.mcp.json`, `gemini-extension.json`, and the `mcpServers` pointers in the Cursor and Codex manifests from that one edit. Reversing it deletes them again.

Nothing needs to be registered anywhere for a server to work: installing the plugin is what wires it up. Public MCP directories are discovery, and separate.

## Repository layout

Hand-authored:

```
plugin.json          Agent Plugins v1 manifest, and the version source of truth
mcp.json             MCP server config (empty in v0.1.0) - closed schema, no extra keys
mcp.staged.json      servers built but not yet live; not spec-governed, not read by the build
overlays/*.json      per-client extras the closed spec schema cannot hold
skills/              the payload
skills.json          explicit expected skill list, asserted by conformance
```

Generated by `npm run build` — never hand-edit:

```
.claude-plugin/      .cursor-plugin/      .codex-plugin/
.agents/plugins/     .mcp.json            gemini-extension.json
plugins/blockonomics/    Codex bundle (a materialized copy)
package.json             version field only
```

## Development

```bash
npm run build       # regenerate every client manifest and the Codex bundle
npm run verify      # build --check + conformance; what CI runs
```

`npm run verify` is not optional ceremony. The Agent Plugins spec fails **silently** on a malformed `skills/` directory: the plugin installs cleanly, manifests validate, and the entire skill payload is simply absent with no error shown to the user. `scripts/conformance.mjs` asserts the positive — exactly the skills listed in `skills.json`, all real directories, no symlinks, frontmatter `name` matching each directory, every `description` substantive enough to route on.

To add a skill: create `skills/<name>/SKILL.md` with `name` and `description` frontmatter, add the name to `skills.json`, then run `npm run build`.

Bump the version in `plugin.json` only — `package.json` and every bundled manifest follow from the build.

## Links

- [API documentation](https://developers.blockonomics.co/docs)
- [OpenAPI spec](https://developers.blockonomics.co/openapi.json)
- [llms.txt](https://developers.blockonomics.co/llms.txt) · [llms-full.txt](https://developers.blockonomics.co/llms-full.txt)

## License

MIT
