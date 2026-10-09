# Walking the Foundation team through Steward

A session where everyone in the room meets the platform the way a nonprofit
does, then watches the decisions get made. About 25 minutes.

## Why this runs in production

There is nowhere else to run it. Preview claims no public hostname: at the
cutover the live addresses moved to `[env.production]` and the default
environment was left with `routes = []`, so there is no staging address a
colleague can open in a browser. Giving it one is not a small job either --
the Turnstile widget is scoped to `apply.houstontexansfoundation.org`, so a
new hostname would have its tokens refused and the public form, which is the
first thing this demo shows, would not work.

So: production, with one obviously-fake grantee, and eyes open about what it
leaves behind. See "What this leaves behind".

## Before the session

### 1. Make the demo grant

A one-row CSV, imported through **More > Programs** -> import grants. The columns
the importer requires:

    external_reference,organization_name,ein,program_slug,awarded_amount,awarded_date,grantee_contact_name,grantee_contact_email
    DEMO-01,Demo Nonprofit (not a real grantee),,inspire-change,1,2026-10-06,Demo Contact,<an address you control>

Three things about that row:

- **The EIN is left empty, deliberately.** Never invent one: nine digits
  chosen at random may well belong to a real nonprofit, and it would sit in
  our records attached to a fake organization. An empty EIN is honest and the
  importer accepts it.
- **One dollar.** Zero is refused -- the importer requires an amount above
  zero -- and a dollar cannot distort a figure anybody reports.
- **A 2026 date**, so the row can never be swept into the real 2025 request.
- Check `program_slug` against what Configuration shows for Inspire Change.

### 2. Give it something to report

Ask past grantees for an update, window `2026-01-01` to `2026-12-31`, due a
few weeks out. The dry run will name Demo Nonprofit and skip the end-to-end
test org with "this award has already been asked", which is worth seeing.

Now there is one report waiting on one demo grant.

## The session

### Part A -- everyone, 5 minutes, on their own phones

`apply.houstontexansfoundation.org/tell-us`, each person claiming **Demo
Nonprofit** with their own work address.

Everyone gets the acknowledgement within seconds. Let them read it on the
phone: this is a nonprofit's first impression of the Foundation, and it is
the first time most of the room will have seen the platform's voice.

### Part B -- projected, 10 minutes. The part that matters.

Open Past grantees. Everybody's name is in the queue.

- **Connect one person.** Search one distinctive word rather than the whole
  name, pick the award, read the consequence line out loud, press Connect.
- **Decline another, with a reason.** Then point at the banner: *no email was
  sent*. That misconception is better killed in a room than in a help page.

### Part C -- the connected person, 5 minutes

They get the sign-in email, tap the link on their phone -- no password -- and
file the report. Have them photograph something in the room and attach it.

### Part D -- projected, 5 minutes

Open the submission. The photograph is there. Accept it.

## Only connect one person

There is one report period per award, so a second person connected to the
same grant finds the report already filed. Everyone else experiences A, B and
D, which is where the learning is.

## What this leaves behind

Some of it cannot be removed from the interface, and that is worth knowing
before rather than after:

- **Every attendee's claim** stays in the Decided list. Harmless, permanent.
- **Whoever you connected** becomes a grantee user on the demo organization.
  There is no disconnect in the application yet; see docs/ROADMAP.md.
- **The demo award** stays in the awards table and appears in dashboard totals
  and exports, at one dollar.
- **The organization** cannot be junked, because junkOrganization refuses an
  organization holding awards -- correctly, they are financial records.

Name the organization so that nobody mistakes it for real, and the residue is
a dollar and a few rows. The end-to-end test organization is already there on
the same terms.
