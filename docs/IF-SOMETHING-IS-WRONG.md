# If something is wrong

The 3am page. Short on purpose.

If you are reading this during an open deadline, start at **Stop the bleeding**
and ignore the rest until it is handled.

---

## Stop the bleeding

### Stop mail going out

**The nightly send is already off** unless somebody turned it on.
`REMINDERS_AUTOMATIC` must be exactly `"on"` in `wrangler.toml` for the cron to
mail anybody. If it is set, remove it and redeploy:

```
npm run deploy:production
```

Nothing else mails on a schedule. Everything else needs a person to press a
button.

### Stop applicants reaching a broken form

Close the cycle. **More ▾ → Programs** (`/configuration`) → the cycle →
**Close**. The public page then says nothing is open, which is a clear message
rather than a broken one. Drafts are not lost.

### A grantee cannot sign in

Sign-in links are single-use and expire in 15 minutes. The commonest causes, in
order: they clicked an old link, the link was forwarded and already used, or
the mail never arrived. Ask them to request a new one from
`apply.houstontexansfoundation.org/reports`.

A reminder email never contains a sign-in link, by design. If somebody says
"the link in the reminder doesn't work", they are clicking the button that
takes them to the page — which is correct.

---

## What cannot be undone

Know these before you press anything at 3am.

| Action | Reversible? |
|---|---|
| Accepting a report | **No.** Accepted is terminal. |
| Sending any email | **No.** |
| Recording a decision | **No** — there is no correction path yet. |
| Recording a payment as paid | **No** — it cannot be voided or reissued. |
| Publishing a form | **No.** Publish a new version instead. |
| Creating report obligations | **No** in the app. Needs a developer. |
| Connecting a grantee claim to an award | **No.** |
| Closing a cycle | Yes — it can be reopened. |
| Changing a report due date | Yes — audited, one row at a time. |
| Soft-deleting anything | Yes — nothing is hard-deleted. |

---

## Who to call

- **The other admins:** Adam Cann, Allie Gentile and Amanda Grosdidier. All
  three can do anything in this system, including everything on this page. If
  you are reading this because one of them is unreachable, try the other two.
  Verify at any time with `npm run golive`, which names every active admin who
  has never signed in — an account nobody has used is an assumption about
  Cloudflare Access, not a continuity plan.
- **Mail delivery into `houstontexans.com`:** the Texans' own mail admins.
  Messages from the Foundation domain authenticate correctly (SPF, DKIM and
  DMARC all pass — confirmed by Google's own DMARC report) and are still
  dropped inside that tenant. It does not affect grantees, who are on their own
  domains.

---

## Is it actually broken? Check in this order

```
npm run golive
```

That answers most of it: are the hostnames serving, is the staff side behind
Access, is the applicant side **not**, are migrations applied, are there two
admins.

```
npx wrangler d1 execute steward-production --remote --env production --yes \
  --json --command="SELECT severity, code, COUNT(*) n FROM error_log WHERE created_at > datetime('now','-1 day') GROUP BY severity, code ORDER BY n DESC"
```

Recent errors, worst first. `REMINDERS_AUTOMATIC_OFF` appearing here is not a
fault — it is the nightly job correctly declining to mail anybody.

**A 7403 from either command is intermittent.** Run it again before concluding
anything. It was once believed to be caused by a missing `--json` flag; that
was disproved on 2026-10-08.

---

## Things that look broken and are not

- **"No cycle is open."** Correct between rounds. Nobody can apply, which is
  intended.
- **Reminders sent nothing.** Either nobody was due, or the switch is off.
  `error_log` will say which.
- **A report shows as `submitted` and the grantee is chasing you.** It is with
  you, not them. Open it from `/reporting` and accept or return it.
- **The dry run says 12 instead of 13.** An award already has a report period,
  so the ask skips it. Find which before pressing anything.
- **Data health shows thirteen organizations with no EIN.** True, and there is
  no screen to add one. The 2025 import had no EIN column.

---

## Known wrong, as of 2026-10-09

Keep these in mind before you act on a number.

- **No bounce handling.** `sent` does not mean delivered. A dead address looks
  identical to a grantee ignoring you.
- **Reported spend is unverified.** Nothing compares what a grantee types to
  what was awarded or paid.
- **A paid payment cannot be reversed**, and partial payments cannot be
  recorded at all.
- **There is no grant-level export.** One aggregate CSV at
  `/api/dashboard.csv`, and nothing else for a board.
- **The audit log is not readable in the app.** Every write is recorded; seeing
  it needs a developer and a terminal.
