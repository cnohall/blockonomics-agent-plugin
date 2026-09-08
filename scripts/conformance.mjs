#!/usr/bin/env node
/**
 * Agent Plugins v1.0.0 conformance validator.
 *
 * The spec ships no official linter, and its failure semantics are SILENT: a
 * malformed `skills/` directory is non-fatal, so the plugin installs cleanly, MCP
 * servers connect, and the entire skill payload is simply absent with no error
 * surfaced to the user.
 *
 * The single most valuable assertion here is therefore a POSITIVE one:
 * "exactly N skills, all real directories, zero symlinks, frontmatter intact".
 *
 * @see https://agent-plugins.org/specification
 */

import { readFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = "1.0.0";
const PLUGIN_SCHEMA = `https://agent-plugins.org/schemas/${SPEC}/plugin.schema.json`;
const MCP_SCHEMA = `https://agent-plugins.org/schemas/${SPEC}/mcp.schema.json`;

/** Closed key sets, transcribed from the published JSON Schemas. */
const PLUGIN_KEYS = new Set([
    "$schema", "name", "version", "description", "author",
    "homepage", "repository", "license", "keywords", "extensions",
]);
const AUTHOR_KEYS = new Set(["name", "email", "url"]);
const SERVER_KEYS = {
    stdio: new Set(["type", "command", "args", "env", "cwd"]),
    "streamable-http": new Set(["type", "url", "headers"]),
    sse: new Set(["type", "url", "headers"]),
};
const NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

/**
 * The expected skill set is an explicit list in skills.json, not a magic number: an
 * intentional addition or removal shows up as a reviewable diff in that file, while
 * an accidental drop still fails the build.
 */
const EXPECTED_SKILLS = read("skills.json").skills;

const failures = [];
let checked = 0;

const check = (label, condition, detail = "") => {
    checked += 1;
    if (!condition) failures.push(detail ? `${label}: ${detail}` : label);
};

// ---- plugin.json -----------------------------------------------------------
const plugin = read("plugin.json");

check("plugin.json declares the v1.0.0 schema", plugin.$schema === PLUGIN_SCHEMA, plugin.$schema);
check("plugin name matches the spec name pattern", NAME_RE.test(plugin.name ?? ""), plugin.name);
check("plugin version is semver", SEMVER_RE.test(plugin.version ?? ""), plugin.version);
check("plugin description is present", Boolean(plugin.description));
check("plugin license is present", Boolean(plugin.license));

const strayPluginKeys = Object.keys(plugin).filter((k) => !PLUGIN_KEYS.has(k));
check("plugin.json carries no keys outside the closed schema", strayPluginKeys.length === 0, strayPluginKeys.join(", "));

const strayAuthorKeys = Object.keys(plugin.author ?? {}).filter((k) => !AUTHOR_KEYS.has(k));
check("author object carries no keys outside the closed schema", strayAuthorKeys.length === 0, strayAuthorKeys.join(", "));

// ---- mcp.json --------------------------------------------------------------
const mcp = read("mcp.json");
const servers = mcp.mcpServers ?? {};

check("mcp.json declares the v1.0.0 schema", mcp.$schema === MCP_SCHEMA, mcp.$schema);
check("mcp.json has an mcpServers object", typeof servers === "object" && servers !== null);

for (const [serverName, server] of Object.entries(servers)) {
    const allowed = SERVER_KEYS[server.type];
    check(`server "${serverName}" declares a known transport`, Boolean(allowed), server.type);
    if (!allowed) continue;

    // A key outside the union silently skips the ENTIRE server entry rather than
    // erroring, so the server is simply missing at runtime with no diagnostic.
    const stray = Object.keys(server).filter((k) => !allowed.has(k));
    check(`server "${serverName}" carries no keys outside the ${server.type} union`, stray.length === 0, stray.join(", "));

    if (server.type !== "stdio") {
        check(`server "${serverName}" uses an https URL`, String(server.url).startsWith("https://"), server.url);
    }
}

// ---- skills/ ---------------------------------------------------------------
const skillsDir = join(ROOT, "skills");
check("skills/ exists", existsSync(skillsDir));

const entries = existsSync(skillsDir) ? readdirSync(skillsDir, { withFileTypes: true }) : [];
const actualSkills = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
const expected = [...EXPECTED_SKILLS].sort();

check(
    `skills/ holds exactly the ${expected.length} skills declared in skills.json`,
    JSON.stringify(actualSkills) === JSON.stringify(expected),
    `found [${actualSkills.join(", ")}]`,
);

// Clients differ on symlink handling and Codex clones without submodules, so every
// skill must be a real directory on disk.
const symlinked = entries.filter((e) => lstatSync(join(skillsDir, e.name)).isSymbolicLink()).map((e) => e.name);
check("no skill entry is a symlink", symlinked.length === 0, symlinked.join(", "));

for (const skill of actualSkills) {
    const file = join(skillsDir, skill, "SKILL.md");
    if (!existsSync(file)) {
        check(`skill "${skill}" has a SKILL.md`, false);
        continue;
    }
    check(`skill "${skill}" has a SKILL.md`, true);

    const body = readFileSync(file, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
    check(`skill "${skill}" opens with YAML frontmatter`, Boolean(frontmatter));
    if (!frontmatter) continue;

    const field = (key) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter[1])?.[1]?.trim();
    const declaredName = field("name");
    const description = field("description");

    // The spec requires the directory name and the frontmatter name to match; a
    // mismatch drops the skill silently.
    check(`skill "${skill}" frontmatter name matches its directory`, declaredName === skill, declaredName);

    // description is the routing signal - an agent decides whether to load the skill
    // from this line alone, so an empty or stub description makes the skill dead weight.
    check(`skill "${skill}" has a substantive description`, Boolean(description) && description.length >= 40, description);
}

// ---- report ----------------------------------------------------------------
if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL  ${failure}`);
    console.error(`\n${failures.length} of ${checked} conformance checks failed.`);
    process.exit(1);
}

console.log(`all ${checked} conformance checks passed (${actualSkills.length} skills, ${Object.keys(servers).length} MCP servers)`);
