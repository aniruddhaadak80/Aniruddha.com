#!/usr/bin/env node
/**
 * check-links.mjs — verify that every *local* asset/link reference in this
 * repository actually resolves to a file that is committed here.
 *
 * Catches the classic "the page links to style.css / favicon.ico / script.js
 * but that file was never committed" bug, which otherwise shows up as a 404
 * in the browser console and a silently unstyled page.
 *
 * Usage: node .github/scripts/check-links.mjs
 * Exit code: 0 = all references resolve, 1 = at least one broken reference.
 */
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.argv[2] || process.cwd());

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  "out",
  ".next",
  ".vercel",
  "coverage",
]);
const SOURCE_EXT = new Set([".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx"]);
const MODULE_EXT = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"];
const PUBLIC_DIRS = ["public"];

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), acc);
    } else {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const allFiles = walk(repoRoot).map((f) => path.relative(repoRoot, f).split(path.sep).join("/"));

/**
 * Schemes that are safe to reference from a document. This is deliberately a
 * positive allow-list: anything else that carries a scheme (`javascript:`,
 * `vbscript:`, `data:`, ...) can execute code in the browser and is reported
 * as a problem rather than being silently ignored.
 */
const SAFE_SCHEME = /^(?:https?|mailto|tel|ftp|sms|geo):/i;

/** Matches the scheme of a URL, if it has one. */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function isExternal(url) {
  return (
    url === "" ||
    url.startsWith("#") ||
    url.startsWith("//") ||
    url.startsWith("{%") ||
    url.includes("${") ||
    url.startsWith("%PUBLIC_URL%") ||
    SAFE_SCHEME.test(url)
  );
}

/** Does `target` exist as a file (or as a directory containing index.html)? */
function targetExists(target) {
  if (fs.existsSync(target)) {
    if (fs.statSync(target).isFile()) return true;
    return fs.existsSync(path.join(target, "index.html"));
  }
  // Case-insensitive fallback (Windows/macOS file systems).
  const dir = path.dirname(target);
  const want = path.basename(target).toLowerCase();
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.toLowerCase() === want) return true;
    }
  }
  return false;
}

function decode(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * Resolve a relative reference found in `fromFile` and report whether it exists.
 * `kind` is "asset" for html/css references and "module" for JS imports.
 */
function resolveReference(fromFile, rawUrl, kind) {
  let url = rawUrl.trim();
  if (!url || isExternal(url)) return true;

  const withoutFragment = url.split("#")[0].split("?")[0];
  if (!withoutFragment) return true;

  // Root-absolute references ("/foo") are resolved by the web server, not by
  // the repository layout, so we cannot verify them here.
  if (withoutFragment.startsWith("/")) return true;

  const candidates = new Set([withoutFragment, decode(withoutFragment)]);
  const baseDir = path.dirname(path.join(repoRoot, fromFile));

  for (const candidate of candidates) {
    const target = path.resolve(baseDir, candidate);
    if (targetExists(target)) return true;

    if (kind === "module") {
      for (const ext of MODULE_EXT) {
        if (targetExists(target + ext)) return true;
      }
      for (const ext of MODULE_EXT) {
        if (targetExists(path.join(target, `index${ext}`))) return true;
      }
    }
  }

  // Public-directory assets (e.g. "favicon.ico" referenced from public/index.html)
  for (const publicDir of PUBLIC_DIRS) {
    for (const candidate of candidates) {
      const target = path.join(repoRoot, publicDir, candidate);
      if (targetExists(target)) return true;
    }
  }

  return false;
}

const problems = [];

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Plain-HTTP references are blocked as mixed content when the site is served
 * over HTTPS (which is the case on GitHub Pages / Netlify / Vercel), so they
 * silently fail for every visitor. Loopback URLs are exempt because they are
 * only meaningful on the author's own machine.
 */
const MIXED_CONTENT = /(?:src|href)\s*=\s*["']http:\/\/([^"'/]+)/gi;
const MIXED_CONTENT_FETCH = /fetch\(\s*[`"']http:\/\/([^"'`/]+)/gi;

function isLoopback(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]";
}

const HTML_ATTR = /(?:src|href|data-src|poster)\s*=\s*["']([^"']*)["']/gi;
const CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
const JS_IMPORT = /(?:^|\s)(?:import\s[^'"]*from\s*|import\s*|export\s[^'"]*from\s*|require\s*\(\s*)["']([^"']+)["']/gm;

for (const file of allFiles) {
  const ext = path.extname(file).toLowerCase();
  if (!SOURCE_EXT.has(ext)) continue;
  if (file.endsWith("package-lock.json")) continue;

  const text = fs.readFileSync(path.join(repoRoot, file), "utf8");

  if (ext === ".html" || ext === ".htm") {
    for (const match of text.matchAll(HTML_ATTR)) {
      const url = match[1];
      const scheme = url.trim().match(URL_SCHEME);
      if (scheme && !SAFE_SCHEME.test(url.trim())) {
        problems.push(
          `${file}:${lineOf(text, match.index)}  unsupported URL scheme "${scheme[1]}:" - it can execute code in the browser: "${url}"`,
        );
        continue;
      }
      if (!resolveReference(file, url, "asset")) {
        problems.push(`${file}:${lineOf(text, match.index)}  reference not found in repo: "${url}"`);
      }
    }
  }

  if (ext === ".css") {
    for (const match of text.matchAll(CSS_URL)) {
      const url = match[1];
      const scheme = url.trim().match(URL_SCHEME);
      if (scheme && !SAFE_SCHEME.test(url.trim())) {
        problems.push(
          `${file}:${lineOf(text, match.index)}  unsupported URL scheme "${scheme[1]}:" - it can execute code in the browser: "${url}"`,
        );
        continue;
      }
      if (!resolveReference(file, url, "asset")) {
        problems.push(`${file}:${lineOf(text, match.index)}  url() not found in repo: "${url}"`);
      }
    }
  }

  if ([".js", ".jsx", ".ts", ".tsx"].includes(ext)) {
    for (const match of text.matchAll(JS_IMPORT)) {
      const url = match[1];
      if (!url.startsWith(".")) continue;
      if (!resolveReference(file, url, "module")) {
        problems.push(`${file}:${lineOf(text, match.index)}  module not found in repo: "${url}"`);
      }
    }
  }

  for (const match of text.matchAll(MIXED_CONTENT)) {
    const host = match[1];
    if (isLoopback(host)) {
      problems.push(
        `${file}:${lineOf(text, match.index)}  hard-coded local address "${host}" only works on the author's own machine: "http://${host}/..."`,
      );
      continue;
    }
    problems.push(
      `${file}:${lineOf(text, match.index)}  plain-HTTP reference is blocked as mixed content on HTTPS sites: "http://${host}/..."`,
    );
  }

  for (const match of text.matchAll(MIXED_CONTENT_FETCH)) {
    if (isLoopback(match[1])) continue;
    problems.push(
      `${file}:${lineOf(text, match.index)}  plain-HTTP fetch() is blocked as mixed content on HTTPS sites: "http://${match[1]}/..."`,
    );
  }
}

if (problems.length > 0) {
  console.error("Broken local references found:\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\n${problems.length} broken reference(s).`);
  process.exit(1);
}

console.log(`OK - checked ${allFiles.length} files, every local reference resolves.`);
