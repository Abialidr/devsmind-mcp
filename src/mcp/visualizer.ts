import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The directory this module's assets live in (view.html, view.css, view.js, view_chat.js,
 * view_graph.js, vendor/*) — `src/mcp` under `tsx` dev, `dist/mcp` once built. server.ts's
 * static `/app/:file` and `/vendor/:file` routes read from here.
 */
export const ASSETS_DIR = __dirname;

/**
 * Gate for the routes that write to source files (/api/revert, /api/message-revert,
 * /api/message-unrevert).
 *
 * The server listens on loopback only, which keeps the network out — but not another site in the
 * same browser, which can POST cross-origin without ever reading the response. This token is
 * minted per process and handed only to a page this server itself served, so a request that
 * cannot echo it did not come from the view app.
 */
export const DEVSMIND_TOKEN = crypto.randomBytes(24).toString('hex');

/**
 * Renders view.html fresh off disk on every call, rather than once at module load, so it never
 * drifts out of sync with the JS/CSS assets — which server.ts's `/app/:file` route already reads
 * fresh per-request. Caching the shell here would mean whichever page shipped at process start
 * keeps being served until a restart, even after the on-disk HTML changes to match newer JS —
 * exactly the kind of stale-pairing bug ("elements the JS expects aren't there") this avoids.
 * The file is a few KB; re-reading it per request costs nothing that matters for a local tool.
 */
export function getViewHtml(): string {
  const raw = fs.readFileSync(path.join(ASSETS_DIR, 'view.html'), 'utf8');
  return raw.replace(
    '<!--DEVSMIND_TOKEN-->',
    `<script>const DEVSMIND_TOKEN = ${JSON.stringify(DEVSMIND_TOKEN)};</script>`
  );
}
