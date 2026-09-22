# htx-grants-proxy

The Houston Texans site's read-only window onto Steward.

## What it is for

`houstontexans.com` and `houstontexansfoundation.org` are different registrable
domains. An iframe of Steward on a Pocket page is therefore third-party, and the
session cookie is a third-party cookie — Safari blocks those outright and Chrome
is removing them, so anything behind sign-in cannot work there.

So the Pocket page renders **native blocks in the Texans design system**, reads
public data through this Worker, and links out to
`apply.houstontexansfoundation.org` for anything that needs a session.

This Worker calls Steward server-side, where CORS does not apply. **Steward needs
no allow-list, no new header, and no knowledge that houstontexans.com exists.**

## Deploy

From this directory, not the repo root:

```
cd integrations/houstontexans-proxy
npx wrangler deploy
```

It has no secrets, no bindings and no database. Everything it needs is in
`wrangler.toml`.

## Routes

| Path | Returns |
|---|---|
| `/grants/cycles` | `{ ok: true, cycles: [...] }` — open programs, with `applyUrl` built in |
| `/grants/awarded` | `{ ok: true, grants: [...] }` — published grants, amounts pre-formatted |
| `/health` | Which routes exist, which origins are allowed, and whether Steward answered |

## The one thing to get right in the block

A failure is **503**, never a 200 with an empty list.

An empty list means "no programs are open", which the block renders as *"Nothing
is open right now"*. That sentence would send a nonprofit away when in fact the
Foundation could not be reached. Branch on it:

| Response | Render |
|---|---|
| `200`, cycles present | The list |
| `200`, `cycles: []` | "Nothing is open right now" |
| `503` or a network failure | "We can't load the current programs" + a link to `apply.houstontexansfoundation.org/apply` |

## Caching

Two entries. `fresh` is five minutes and is what everything normally reads.
`backup` is a last-known-good copy kept for a day, read only when Steward cannot
be reached at all — a blip in the grants platform should cost the Foundation's
page a slightly stale deadline, not a blank panel.

The `x-cache` response header says which happened: `hit`, `miss`, or `stale`.

Five minutes is right for a deadline months out. On the last afternoon of a
cycle it means a closed cycle can linger briefly, which is why `closesAt` is in
the payload — the block hides a row whose deadline has passed rather than
trusting the cache.

## Debugging

Open `/health` in a browser first. "The block shows nothing" almost always means
the page is fetching a URL this Worker does not serve, and that page answers it
in a second.
