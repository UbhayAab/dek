# Arc sign-in email presentation (#206)

This source proposal is not an installed template or an authorization to send.
`auth-code206.mjs` is a pure preflight planner, not a database writer. Its returned
values can contain private sender metadata and must not be logged or committed.

## Compatibility and authority

The original console-managed `dek-otp` row stays unchanged. Existing Dek clients
and the signed `auth-email` hook retain their exact old slug and three merge
fields. The hook continues to allow only its existing email-change actions.

The additive `dek-otp-shared206` slug is already covered by Mailer's protected
`dek-otp` namespace and critical OTP classifier. Only the fixed Arc presentation
path selects it. `APP_NAME=Arc`, `APP_INITIAL=A`, and footer `FROM_NAME=Arc` are
constants chosen in the shared function, never client-selected template content.
The new template's envelope display name is fixed `Arc`; sender address and
critical metadata inherit the existing protected source privately.
Native console ownership is `managedBy=null`; the word `console` in the source
snapshot is a display classification, not a value to write into that column.

The browser sends only `app: "arc"`. Exact Arc production/custom/owned Pages
origins are allowlisted. Origin is presentation metadata and can be forged by a
nonbrowser caller; it conveys no identity, permission, eligibility or code grant.
The same account, request token, HMAC, abuse checks, session and verification path
remain authoritative. Missing or explicit `dek` uses the original behavior.

## Reviewed installation order (not yet approved for production)

1. Native Mailer Owner creation first. Privately read the current source row and
   target; map native property names to the camelCase planner shape. Recheck
   current Owner authorization, source subject/body SHA256 and console ownership
   in the same locked write transaction that conditionally creates the target.
   Serialize against source/target edits and concurrent target creation. Do not
   blindly apply a stale read followed by `/api/templates/save` upsert. Existing
   target must match all planned content/sender/critical/ownership fields exactly
   for idempotent success; any difference stops for explicit new review.
2. Record the actual created target ID and a boolean identifying whether this
   transaction created it, with exact content hashes. Never invent provenance for
   an existing matching row. Prove native renderer output with fictional fields.
3. Release only the shared `auth-code` function after the target is verified.
   Untagged old clients still select the unchanged Dek row. The new Arc route
   fails with ordinary `mail_failed` if its template is absent or refused; there
   is no fallback to the wrong brand.
4. Release Arc's `api.mjs` caller last. A new client against the old function would
   have its extra app hint ignored and still show Dek, so the earlier steps are
   required for truthful acceptance. No Auth, key, hook, rate, grant or sender
   channel settings change is part of this proposal.

## Rollback and updates

Roll back Arc caller and shared function before considering target retirement.
Never modify or remove `dek-otp`. Leave the additive target unused whenever any
job, log or other native foreign-key reference exists. Normal Owner retirement
may remove only the exact incarnation created by the recorded transaction, with
all content/metadata unchanged and a fresh complete zero-reference census held
under the same native write transaction. The pure `planRetirement` checks these
inputs but cannot enforce database locks or authorize retirement by itself.

No implicit template update is allowed. A source or target change requires a new
reviewed exact preimage and conditional migration. These safeguards must be
implemented in the eventual normal Mailer provisioning transaction before any
production write; this repository does not introduce an unguarded deployment CLI.

## Provider-free source checks

Run on Node 24 from the Dek root:

```
node --experimental-vm-modules --test supabase/tests/auth-code-branding206.node.mjs supabase/tests/auth-code-template206.node.mjs supabase/tests/auth-email-compat206.node.mjs
```

The VM suite executes actual shared handler/hook code with a trapped transport
and isolated SDK. The pure template suite proves exact source reconstruction and
guard behavior; it does not substitute for the actual Mailer Java renderer.
No test demonstrates real mailbox delivery. Final #206 acceptance still requires
the approved installation and a separately authorized normal Arc code receipt.
