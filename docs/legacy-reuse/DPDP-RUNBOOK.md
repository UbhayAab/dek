# DPDP Runbook - Dek

India's DPDP Act 2023 + Rules 2025 (notified 14 Nov 2025) phase in fully by
**14 May 2027**. This is the operational minimum for a workplace chat SaaS,
written as checklists because checklists get executed.

## Obligation map (what bites, when)

| Date | What starts | Our answer |
|---|---|---|
| Immediate (Nov 2025) | Data Protection Board exists | Nothing to build |
| 14 Nov 2026 | Consent Manager registration regime | N/A - we are not a Consent Manager |
| **14 May 2027** | Notice+consent, breach reporting, security safeguards, data-principal rights, cross-border rules, penalties live | The kit in this repo: privacy.html, retention cron, export/erase RPCs |

Penalty exposure that matters to us: failure to notify a breach - up to
Rs 200 crore. Reasonable security failure - up to Rs 250 crore. This is why the
breach drill below is rehearsed, not documented-and-forgotten.

## 1. Notice and consent (DONE - verify each deploy)

- `privacy.html` is the standalone, itemised notice. It must stay reachable
  from the sign-in screen and from the app footer.
- Sign-in itself is the consent action; the notice link sits beside the form.
- When collection changes (new field, new processor), update privacy.html the
  same commit. A stale notice is a false notice.

## 2. Breach response - the 72-hour clock

Detection sources: Supabase/Cloudflare security emails, errorreport spikes,
a user reporting someone else's data, GitHub secret-scanning alerts.

**Hour 0-1 - Confirm and contain**
- [ ] Reproduce/verify the exposure. Note first-known timestamp.
- [ ] Rotate the implicated secret(s): service-role key, TURN secret, VAPID,
      embed HMAC secrets, GitHub token. (Supabase dashboard + CF dashboard.)
- [ ] If data is still flowing out: disable the leaking edge function
      (`supabase functions delete <name>`) or take Pages deploy offline.

**Hour 1-24 - Notify the Board (intimation, not the full report)**
- [ ] Data Protection Board portal: nature, extent, timing, likely impact.
- [ ] Notify every affected data principal via in-app toast + email list from
      `profiles` (emails are on the account). Plain language: what happened,
      what it means for them, what we did, one contact name.

**Hour 24-72 - Detailed report to the Board**
- [ ] Cause and events, measures taken, person responsible, remediation plan,
      copy of the user notifications sent.
- [ ] Log everything in `docs/incidents/<date>.md` - the Board can ask for the
      timeline later.

**After**
- [ ] Post-mortem within a week. One preventive change shipped, not ten noted.

## 3. Retention (automated)

`supabase/migrations/0102_retention.sql` schedules a nightly pg_cron job:
messages older than 18 months are deleted; storage objects follow via the
attachment metadata join. Verify it ran: `select * from cron.job_run_details
order by start_time desc limit 5;`

## 4. Data principal rights (built, must stay reachable)

- Access/export: `export_my_data` RPC (wrapper exists at js/api.js; surface a
  "Download my data" action in profile settings if it is ever requested).
- Erasure: `anonymize_account` RPC + org admin's 7-day deletion with cancel.
- Grievance: admin contact on sign-in screen; 90-day clock tracked in issues.

## 5. Processors register (keep current)

| Processor | Role | Data |
|---|---|---|
| Supabase (Mumbai) | Database, auth, realtime | Everything relational |
| Cloudflare R2 | File storage | Attachments, avatars |
| Cloudflare Realtime | Voice relay (TURN/SFU) | Ephemeral media, no storage |
| Cloudflare Pages | Static hosting | App shell only |
| Resend/SES (if enabled) | OTP + notification email | Email address |

Cross-border: primary region is Mumbai. Cloudflare edge caches static shell
globally by design; personal data at rest stays in the primary region. If that
changes, this table and privacy.html change in the same commit.
