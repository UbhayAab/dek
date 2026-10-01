// Run a probe against a chosen realtime transport WITHOUT editing js/config.js.
//
// WHY THIS EXISTS. The transport is a build-time constant in js/config.js
// (REALTIME_TRANSPORT). Until now the only way to exercise the Cloudflare path
// was to edit that constant, run the suite, and edit it back - which is how a
// cutover got pushed with four probes still red on 2026-09-22, and how six
// features came to be silently dead on that transport while the suite was green
// on the other one. A suite that can only test the transport already deployed
// cannot tell you anything about the one you are about to deploy.
//
// So the override lives in the TEST process. Playwright's routing answers the
// request for /js/config.js before it reaches the probe's own file server, with
// the real file and one constant rewritten. Nothing on disk changes, nothing
// ships, and there is no runtime override in production for anybody to reach.
//
// Usage, immediately after browser.newContext():
//
//   import { forceTransport } from "./probe-transport.mjs";
//   const context = await browser.newContext({ ... });
//   await forceTransport(context, ROOT);        // honours DEK_TRANSPORT
//
// It is a no-op unless DEK_TRANSPORT is set, so adding the call to a probe
// leaves its normal run byte-for-byte identical:
//
//   DEK_TRANSPORT=cloudflare node scripts/probe-labels.mjs
import fs from "node:fs";
import path from "node:path";

const VALID = new Set(["supabase", "cloudflare"]);

export function wantedTransport() {
  const v = (process.env.DEK_TRANSPORT || "").trim();
  if (!v) return null;
  if (!VALID.has(v)) {
    // Loud. A typo that silently tested the deployed transport instead of the
    // one named is the exact failure this file exists to prevent.
    throw new Error(`DEK_TRANSPORT must be one of ${[...VALID].join(" | ")}, got "${v}"`);
  }
  return v;
}

export async function forceTransport(context, root, transport = wantedTransport()) {
  if (!transport) return null;

  const file = path.join(root, "js", "config.js");
  const original = fs.readFileSync(file, "utf8");

  // Anchored on the whole statement, so a rename or a reformat fails here
  // rather than silently leaving the constant at its deployed value.
  const re = /^export const REALTIME_TRANSPORT = '(?:supabase|cloudflare)';$/m;
  if (!re.test(original)) {
    throw new Error(
      "probe-transport: could not find the REALTIME_TRANSPORT statement in js/config.js. " +
      "It was renamed or reformatted; update the pattern in scripts/probe-transport.mjs " +
      "rather than letting probes report on whichever transport happens to be deployed.",
    );
  }
  const patched = original.replace(re, `export const REALTIME_TRANSPORT = '${transport}';`);

  await context.route("**/js/config.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: patched }));

  console.log(`probe-transport: REALTIME_TRANSPORT forced to '${transport}' for this run`);
  return transport;
}
