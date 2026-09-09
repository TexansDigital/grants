# Email DNS setup — SPF, DKIM, DMARC

Everything here is done once, by a human, in two browser tabs: the Resend
dashboard and Cloudflare DNS. No code changes, no deploy.

Until this is done, **nothing this system sends will reliably arrive.** A
grantee who cannot receive a sign-in link cannot file a report, and there is no
code fix for that. This is the single largest piece of unfinished work between
here and a working applicant flow.

> **A note on accuracy.** Resend's own documentation is unreachable from the
> environment this was written in, so the *shape* of the process below is
> reliable but the exact record names and values are not reproduced here on
> purpose. **Resend generates them for your domain and shows them on screen.
> Copy from that screen, never from this document.** Where this document does
> give a literal value — the DMARC record — it is one you author yourself, not
> one Resend issues.

---

## What the three things actually are

Skip this if you just want the steps, but it makes the failures legible.

Email has no built-in proof of who sent it. Anyone can put
`grants@houstontexansfoundation.org` in the From line. These three records are
how you publish, in DNS, the rules a receiving mail server should apply.

**SPF** — *"these servers are allowed to send as me."* A list, published at your
domain, of who may send on your behalf. Resend's servers have to be on it or
Gmail sees mail claiming to be you from a machine you never authorised.

**DKIM** — *"this message really came from me and was not altered."* Resend
signs each message with a private key; you publish the matching public key in
DNS. This is the strong one: SPF breaks when a message is forwarded, DKIM
survives it.

**DMARC** — *"here is what to do when SPF and DKIM disagree, and tell me about
it."* It ties the other two to the address a human actually sees, and asks
receivers to send you reports. Resend does not require it to verify your domain,
and you can send without it — but Gmail and Yahoo now expect bulk senders to
publish one, and without it you are blind to anyone spoofing your domain.

The short version: **SPF and DKIM get your mail delivered. DMARC tells you
whether it is working and stops other people forging you.**

---

## Before you start

You need:

- Access to the Cloudflare account holding `houstontexansfoundation.org`.
- A Resend account. Free tier is fine — expected volume is 150–250 messages a
  month against a 3,000/month allowance.
- About 20 minutes, then a wait. DNS usually resolves in minutes on Cloudflare;
  allow up to a few hours before assuming something is wrong.

**Decide where reports go first.** DMARC reports are XML, they arrive daily, and
they go to a real mailbox. Use a monitored address — not a personal inbox you
will mute after a week. If nobody will read them, say so and we will point them
at a service that summarises them instead.

---

## 1. Add the domain in Resend

1. Sign in to Resend and open **Domains → Add Domain**.
2. Enter `houstontexansfoundation.org`.
3. Pick the region closest to Houston when asked.

Resend then shows you a table of DNS records. **Leave this tab open.** You are
about to copy each row into Cloudflare.

**Do not retype these values. Copy and paste them.** DKIM keys are long
random strings and a single wrong character fails silently — the domain simply
never verifies and nothing tells you why.

### Root domain or a subdomain?

Resend may offer to verify `houstontexansfoundation.org` or a subdomain such as
`mail.houstontexansfoundation.org`. **Use the root domain.** This domain was
bought specifically for this platform and hosts nothing else, so there is no
existing reputation to protect by isolating the grants mail. The application
config already expects `grants@houstontexansfoundation.org`.

If you ever put staff mailboxes (Google Workspace, Microsoft 365) on this same
domain, come back and re-read step 4 — you will need to merge SPF records rather
than add a second one.

---

## 2. Copy each record into Cloudflare

In a second tab: **Cloudflare dashboard → houstontexansfoundation.org → DNS →
Records**.

For each row Resend shows, click **Add record** and fill in the three fields
Resend gives you: type (TXT, MX, or CNAME), name, and value.

Then three Cloudflare-specific traps, all of which cause the same symptom —
"I added everything and it still says Pending":

### Trap 1 — the orange cloud

If a record offers a **Proxy status** toggle, set it to **DNS only** (grey
cloud), never **Proxied** (orange cloud).

A proxied record does not answer as a plain DNS record, so Resend cannot read it
and verification never completes. This applies to CNAME records in particular.
**Resend now issues CNAME records for domains added recently**, so you are
likely to hit this. TXT and MX records cannot be proxied and will not show the
toggle at all.

### Trap 2 — the doubled domain name

Cloudflare **appends your domain automatically**. If Resend says the name is
`resend._domainkey` and you type that, Cloudflare stores
`resend._domainkey.houstontexansfoundation.org`. Correct.

But if Resend shows the full name — `resend._domainkey.houstontexansfoundation.org`
— and you paste all of it, Cloudflare stores
`resend._domainkey.houstontexansfoundation.org.houstontexansfoundation.org`.
Wrong, and it looks right in the list until you read the end of the line.

**After adding each record, read the name Cloudflare displays and check the
domain appears exactly once.** If Resend gives a full name, paste it and delete
the trailing `.houstontexansfoundation.org` before saving.

A name of `@` means the domain itself, with nothing in front.

### Trap 3 — an existing MX record

If Resend asks for an MX record and Cloudflare already has one, look at what is
there before touching it. Cloudflare **Email Routing** adds its own MX records,
and if it is enabled on this domain it will fight with Resend's.

Two different MX setups on the same name is a genuine conflict. Stop and ask
rather than guessing — this is the one step where a wrong move can break
inbound mail.

---

## 3. Verify in Resend

Back in the Resend tab, click **Verify**.

- **Verified** — done, move to step 4.
- **Pending** — normal for the first few minutes. Wait, then click again.
- **Still pending after an hour** — go to Troubleshooting below.

Resend verifies on SPF, DKIM and MX. **DMARC is not part of this check**, which
is why step 4 is easy to forget — the dashboard will go green without it.

---

## 4. Add the DMARC record yourself

Resend does not issue this one. You author it.

In Cloudflare → DNS → Records → **Add record**:

| Field | Value |
|---|---|
| Type | `TXT` |
| Name | `_dmarc` |
| Content | `v=DMARC1; p=none; rua=mailto:dmarc@houstontexansfoundation.org; fo=1` |
| TTL | Auto |

Replace the `rua` address with the monitored mailbox you chose earlier. That
mailbox must exist and be able to receive mail.

Reading the record:

- `v=DMARC1` — which version. Required, always this.
- `p=none` — **the policy: do nothing, just report.** Explained below.
- `rua=mailto:...` — where the daily aggregate reports go.
- `fo=1` — send a report whenever *any* check fails, not only when everything
  fails. More signal while you are setting up.

### Start at `p=none`. This matters.

`p=none` means "if a message fails these checks, deliver it anyway, but tell
me." It looks like the useless setting. It is the correct one to start with.

The stricter values — `p=quarantine` (send to spam) and `p=reject` (refuse
outright) — are instructions to *throw away mail that fails*. Publish `p=reject`
before you know your own mail passes, and the first thing it rejects is your own
decline letters to 250 nonprofits, silently, with no bounce you will notice.

So: **publish `p=none`, send real mail for two to four weeks, read the reports,
confirm everything legitimate is passing, and only then tighten.** Come back and
ask when you are at that point — reading the first DMARC report is genuinely
unpleasant and I can walk you through it.

---

## 5. Set the API key as a secret

Only once the domain shows **Verified**:

1. Resend → **API Keys → Create API Key**. Give it **Sending access** only.
2. Copy the key. It is shown once.
3. From the project root:

```
npx wrangler secret put RESEND_API_KEY
```

Paste when prompted.

**Never put this key in `wrangler.toml`, in a committed `.env`, or in a code
comment.** `npm run check:config` fails the build if it finds a key-shaped value
in the config file, but the guard is a backstop, not permission to try.

Setting this key is the single action that makes an environment able to email
real people. With no key the system records every send as `suppressed` and calls
nothing — which is why preview and staging deliberately have none.

---

## 6. Confirm it actually works

The dashboard going green means DNS is readable. It does not mean mail arrives.

**Send one real message to yourself**, then open it and look at the raw source
(Gmail: the three-dot menu → **Show original**). You want three lines:

```
SPF:   PASS
DKIM:  PASS
DMARC: PASS
```

All three passing on a message that landed in the inbox — not spam — is the
first honest evidence this works. Nothing before that point is.

If you want to check DNS from a terminal first:

```
dig +short TXT _dmarc.houstontexansfoundation.org
dig +short TXT houstontexansfoundation.org
```

On Windows, `nslookup -type=TXT _dmarc.houstontexansfoundation.org`. Or paste
the domain into any web-based DNS lookup tool.

---

## Troubleshooting

**"Pending" for more than an hour.** In order of how often each is the cause:

1. **A proxied record.** Check every record Resend asked for is grey-cloud
   **DNS only**. This is the most common cause on Cloudflare by a wide margin.
2. **A doubled domain name.** Read the full name of each record and confirm
   `houstontexansfoundation.org` appears exactly once.
3. **A truncated or altered value.** Delete the record and paste it again.
   Watch for a leading or trailing space, and for quotes your browser may have
   added around a TXT value.
4. **Two SPF records.** A domain may publish **exactly one** TXT record starting
   `v=spf1`. Two is not additive — it is invalid, and receivers fail both. If
   one already exists, the Resend include has to be merged into it rather than
   added alongside. Ask before doing this by hand.

**Verified, but mail lands in spam.** Usually the domain is simply new and has
no sending history. At 150–250 messages a month this settles on its own. Do not
respond by blasting volume to "warm it up" — that is the thing that gets a new
domain flagged.

**Verified, but nothing sends at all.** Check `RESEND_API_KEY` is actually set
on the environment you are running:

```
npx wrangler secret list
```

An unset key is not an error condition in this system — it records every message
as `suppressed`, on purpose, so a preview run cannot mail an applicant. If sends
are being suppressed, this is why.

---

## What is still not covered

- **Bounce and complaint handling.** Resend can post these back to us via a
  webhook. Nothing consumes one yet, so a hard bounce is currently something a
  human notices, not something the system records.
- **Whether reports get read.** A `rua` address nobody opens is the same as no
  DMARC at all for detection purposes, though the record still helps
  deliverability.
- **Tightening past `p=none`.** Deliberately deferred until there is real
  sending history to read.
