# Questions for the Foundation team

Decisions this platform needs from people, not from engineering. None of them
block the 2025 update; most block the 2026 application cycle. Bring the first
section to the first session, because one of them gates sending anything.

Where CLAUDE.md's "Open decisions" and this file overlap, this one is the
agenda and that one is the record.

## Before anything is sent to the thirteen

**1. What date is the 2025 update due?**

This is the only thing standing between here and asking the thirteen for
their updates, and it is a judgement about what is reasonable to ask, not a
technical input.

It is also the send schedule, which is the part that surprises people: the
button writes the obligations and emails nobody. The nightly job then mails
each grantee at **14 days before, 3 days before, and on the day**, then weekly
once overdue. So a due date inside 14 days means everyone is emailed tomorrow
morning; three or four weeks out leaves room to send the human note first.

**2. Who sends the human note, and when?**

The system cannot chase an organization that has never claimed its grant --
reminders only reach addresses that already have an account. Until a nonprofit
comes through `/tell-us` and an admin connects them, they are invisible to
every automated nudge. Somebody has to write to the thirteen, and somebody has
to watch the Past grantees queue and notice who has not appeared in it.

**3. Who holds the second admin account, and what happens if the primary
owner is away during an open cycle?**

Two admins exist from day one by design. The runbook for "the person who knows
this is unreachable and a deadline is today" does not exist yet.

## Before the 2026 application cycle opens

**4. The scoring rubric.** Criteria, weights, maximum scores. Uploaded as CSV
or XLSX and confirmed by an admin. Nothing in review works without it.

**5. Impact metrics** for the application side -- what the Foundation wants to
be able to count across a programme, decided before the form is built rather
than after the answers are in.

**6. Decline letter wording.** Fifty acceptances and 250 declines go out the
same week and the decline is the one that gets screenshotted. It is never sent
automatically; a person reviews every one. Somebody has to write the words.

**7. Do declined applicants keep portal access** to reapply next cycle with
their details pre-filled?

**8. What is the grace rule** for a draft started before a cycle closes but
submitted after?

## Policy, whenever somebody can decide

**9. Retention of uploaded financial statements.** Currently 90 days after an
application is decided, with no clock at all on anything that produced an
award. Is 90 right?

**10. Do outside review consultants need a confidentiality agreement tracked
in the system,** or is that handled offline?

**11. Are award agreements e-signed in the system later,** or do they stay a
manual upload?

**12. Does the NFL impose any reporting format or platform requirement** on
Inspire Change funds? If it does, it is cheaper to know before the 2026 form
is built than after.

## Things to tell them rather than ask

- **Declining a past-grantee claim sends nothing.** Deliberately -- "we have
  no record of funding you" should come from a person who can answer the next
  question. The screen says so. Somebody still has to make the call.
- **Connecting a claim to the wrong award cannot be undone in the app.** Check
  the award before pressing Connect. See docs/ROADMAP.md.
- **The domain is not yet protected from spoofing.** DMARC is on `p=none`,
  which monitors and enforces nothing. Tightening it needs two to three weeks
  of reports first, so that a sender nobody remembered does not start landing
  in spam.
