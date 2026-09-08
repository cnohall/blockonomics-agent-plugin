#!/usr/bin/env node
/**
 * Single generator for every provider-specific artifact.
 *
 * Canonical, hand-authored source:
 *   plugin.json          Agent Plugins v1.0.0 manifest (also the version source of truth)
 *   mcp.json             Agent Plugins v1.0.0 MCP config
 *   overlays/*.json      per-provider extras the closed spec schema cannot hold
 *   skills/              the payload
 *
 * Generated (never hand-edit):
 *   .claude-plugin/plugin.json        .claude-plugin/marketplace.json
 *   .cursor-plugin/plugin.json        .codex-plugin/plugin.json
 *   .agents/plugins/marketplace.json  .mcp.json
 *   gemini-extension.json             plugins/blockonomics/ (bundle)
 *   package.json (version field only)
 *
 * Usage:
 *   node scripts/build.mjs            write artifacts
 *   node scripts/build.mjs --check    verify artifacts match source, exit 1 on drift
 *
 * @see https://agent-plugins.org/specification
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

/**
 * Codex's `plugin marketplace add` performs a plain `git clone`, and its marketplace
 * schema has historically rejected a self-referencing source path, so Codex is served
 * from a materialized bundle rather than the repo root.
 */
const BUNDLE = "plugins/blockonomics";

const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const serialize = (value) => `${JSON.stringify(value, null, 4)}\n`;

/** Strip the `//`-prefixed comment convention used in overlay and staging files. */
const stripComments = (obj) =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith("//")));

const plugin = read("plugin.json");
const mcp = read("mcp.json");
const overlays = {
    claude: stripComments(read("overlays/claude.json")),
    cursor: stripComments(read("overlays/cursor.json")),
};

const { version, name, author, homepage, repository, license } = plugin;

/**
 * v0.1.0 ships skills only. Emitting a manifest entry for a server that is not yet
 * live surfaces to the user as a client-side connection failure on every session, so
 * the MCP artifacts are omitted entirely until mcp.json declares a server. Flipping a
 * staged server into `mcpServers` turns all of this on with no other edit.
 */
const servers = mcp.mcpServers ?? {};
const hasMcp = Object.keys(servers).length > 0;

const codexInterface = () => {
    const value = plugin.extensions?.["com.openai"]?.interface;
    if (!value) {
        console.error("plugin.json is missing the com.openai interface extension, which the Codex manifests require.");
        process.exit(1);
    }
    return value;
};

/** Spec-only fields that must never leak into a legacy provider manifest. */
const portableBase = () => {
    const { $schema, extensions, keywords, ...rest } = plugin;
    return rest;
};

const keywordsFor = (tag) => {
    const base = plugin.keywords.filter((k) => k !== "mcp" && k !== "skills");
    return hasMcp ? [...base, tag, "mcp", "skills"] : [...base, tag, "skills"];
};

/**
 * `.mcp.json` for Claude Code and Cursor, projected from the canonical config.
 *
 * Two deliberate differences from mcp.json:
 * - `enabled` is not a member of the Agent Plugins closed server union, and a stray
 *   key silently skips the whole entry, so it lives only here.
 * - Remote transports are wrapped in the `mcp-remote` stdio bridge for clients without
 *   native streamable-HTTP. URLs are derived, never duplicated, so the two files
 *   cannot drift apart.
 */
function legacyMcpConfig() {
    const toStdio = (server) =>
        server.type === "stdio"
            ? server
            : { type: "stdio", command: "npx", args: ["-y", "mcp-remote@latest", server.url] };

    return {
        mcpServers: Object.fromEntries(
            Object.entries(servers).map(([serverName, server]) => [
                serverName,
                { ...toStdio(server), enabled: true },
            ]),
        ),
    };
}

function codexManifest() {
    return {
        ...portableBase(),
        description: hasMcp
            ? "Blockonomics tools for Codex: Bitcoin and USDT integration skills + docs/API MCP servers."
            : "Blockonomics tools for Codex: Bitcoin and USDT integration skills.",
        keywords: keywordsFor("codex"),
        skills: "./skills/",
        ...(hasMcp ? { mcpServers: "./.mcp.json" } : {}),
        interface: codexInterface(),
    };
}

const claudeDescription = hasMcp
    ? "Blockonomics tools for Claude Code, including Bitcoin and USDT integration skills and the Blockonomics docs and API MCP servers."
    : "Blockonomics tools for Claude Code: agent skills for accepting Bitcoin and USDT payments.";

const artifacts = {
    // ---- Claude Code -------------------------------------------------------
    ".claude-plugin/plugin.json": {
        ...portableBase(),
        description: claudeDescription,
        keywords: keywordsFor("claude-code"),
        ...overlays.claude,
    },

    ".claude-plugin/marketplace.json": {
        name,
        owner: { name: author.name, email: author.email },
        metadata: { description: "Blockonomics plugin marketplace for Claude Code.", version },
        plugins: [
            {
                name,
                source: "./",
                description: claudeDescription,
                author: { name: author.name, email: author.email },
                homepage,
                repository,
                license,
                keywords: keywordsFor("claude-code"),
            },
        ],
    },

    // ---- Cursor ------------------------------------------------------------
    // Cursor's native loader reads .cursor-plugin/plugin.json and expects component
    // paths without a leading "./" (unlike Codex).
    ".cursor-plugin/plugin.json": {
        ...portableBase(),
        description: "Blockonomics tools for Cursor: Bitcoin and USDT integration skills.",
        keywords: keywordsFor("cursor"),
        ...overlays.cursor,
        ...(hasMcp ? { mcpServers: ".mcp.json" } : {}),
    },

    // ---- Codex CLI ---------------------------------------------------------
    // Codex reads the root Agent Plugins manifest natively, but the marketplace
    // validator is a separate code path, so the marketplace points at the bundle.
    ".agents/plugins/marketplace.json": {
        name,
        interface: { displayName: codexInterface().displayName },
        plugins: [
            {
                name,
                source: { source: "local", path: `./${BUNDLE}` },
                policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
                category: codexInterface().category,
            },
        ],
    },

    ".codex-plugin/plugin.json": codexManifest(),

    // ---- Codex bundle ------------------------------------------------------
    // Self-contained copy so the bundle is valid whether Codex resolves it as an
    // Agent Plugin (plugin.json + mcp.json) or via the legacy overlay.
    [`${BUNDLE}/plugin.json`]: plugin,
    [`${BUNDLE}/mcp.json`]: { $schema: mcp.$schema, mcpServers: servers },
    [`${BUNDLE}/.codex-plugin/plugin.json`]: codexManifest(),
};

/**
 * MCP-dependent artifacts. Gemini CLI has no SKILL.md primitive, so its extension is
 * MCP-only and pointless without a server; the docs say so rather than implying parity.
 */
const mcpArtifacts = {
    ".mcp.json": legacyMcpConfig(),
    [`${BUNDLE}/.mcp.json`]: legacyMcpConfig(),
    "gemini-extension.json": {
        name,
        version,
        description:
            "Blockonomics MCP servers: documentation search and live API access. Gemini CLI has no agent-skill primitive, so the skills in this plugin are not available here.",
        mcpServers: Object.fromEntries(
            Object.entries(servers).map(([serverName, server]) => [
                serverName,
                server.type === "stdio" ? { command: server.command, args: server.args } : { httpUrl: server.url },
            ]),
        ),
    },
};

if (hasMcp) Object.assign(artifacts, mcpArtifacts);

// ---- package.json: version field only, preserve everything else ------------
const packageJsonUpdated = { ...read("package.json"), version };

const targets = [
    ...Object.entries(artifacts).map(([path, value]) => [path, serialize(value)]),
    ["package.json", serialize(packageJsonUpdated)],
];

let drift = 0;

/** Mirror a source tree into the bundle as real files; symlinks are dereferenced. */
function syncTree(srcRel, destRel) {
    const src = join(ROOT, srcRel);
    const dest = join(ROOT, destRel);
    if (!existsSync(src)) return;

    const listFiles = (dir, base = dir) =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const abs = join(dir, entry.name);
            return entry.isDirectory() ? listFiles(abs, base) : [relative(base, abs)];
        });

    const expected = listFiles(src);

    if (CHECK) {
        const actual = existsSync(dest) ? listFiles(dest) : [];
        const missing = expected.filter((f) => !actual.includes(f));
        const stale = actual.filter((f) => !expected.includes(f));
        // Byte comparison, not UTF-8: assets/ may hold binaries, and decoding those as
        // text collapses invalid sequences to U+FFFD, so real drift can compare equal.
        const differing = expected.filter(
            (f) => actual.includes(f) && Buffer.compare(readFileSync(join(src, f)), readFileSync(join(dest, f))) !== 0,
        );
        for (const f of [...missing, ...stale, ...differing]) {
            console.error(`drift: ${destRel}/${f}`);
            drift += 1;
        }
        return;
    }

    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    console.log(`synced: ${destRel} (${expected.length} files)`);
}

for (const [rel, contents] of targets) {
    const abs = join(ROOT, rel);
    let current = null;
    try {
        current = readFileSync(abs, "utf8");
    } catch {
        // Missing file counts as drift in --check, and is created otherwise.
    }

    if (current === contents) continue;

    if (CHECK) {
        console.error(`drift: ${rel}`);
        drift += 1;
        continue;
    }

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    console.log(`wrote: ${rel}`);
}

// A server removed from mcp.json must take its generated artifacts with it, or a stale
// .mcp.json keeps pointing every Claude Code and Cursor user at a dead endpoint.
if (!hasMcp) {
    for (const rel of Object.keys(mcpArtifacts)) {
        const abs = join(ROOT, rel);
        if (!existsSync(abs)) continue;
        if (CHECK) {
            console.error(`drift: ${rel} exists but mcp.json declares no servers`);
            drift += 1;
        } else {
            rmSync(abs);
            console.log(`removed: ${rel} (no MCP servers declared)`);
        }
    }
}

syncTree("skills", `${BUNDLE}/skills`);
syncTree("assets", `${BUNDLE}/assets`);

if (CHECK) {
    if (drift > 0) {
        console.error(`\n${drift} artifact(s) out of sync. Run: node scripts/build.mjs`);
        process.exit(1);
    }
    console.log(`all generated artifacts in sync with plugin.json v${version}`);
} else {
    console.log(`\ngenerated ${targets.length} manifests + bundle from plugin.json v${version}`);
}
