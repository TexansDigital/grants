-- A nonprofit saying "you funded us, and here is what we did with it".
--
-- WHY A CLAIM RATHER THAN A SIGN-UP. Access to an award is access to another
-- organization's grant history: what they asked for, what they got, what they
-- have reported. A form that hands that over to whoever types the right
-- organization name is the worst thing this system could offer, and no amount
-- of EIN matching fixes it -- an EIN is printed on every 990 and is not a
-- secret. So a claim is a REQUEST, recorded and answered by a person. Nothing
-- here grants anything; approving it does, and approving it is an admin
-- action with an audit row.
--
-- WHY IT STORES WHAT THEY TYPED. The matched_* columns are what the system
-- THOUGHT at claim time and are advisory only. Staff approve against an award
-- they choose. Keeping the claimant's own words beside the match means a
-- reviewer can see that somebody typed "Bayou Reach" and the system offered
-- "Bayou Reach Collective", rather than being shown a conclusion.
--
-- WHY IT IS NEVER AN ORACLE. The public endpoint answers identically whether
-- or not a matching award exists. Anything else would let anyone test whether
-- a given nonprofit has been funded, one EIN at a time.

CREATE TABLE grantee_claims (
  id                      TEXT PRIMARY KEY,

  -- What the claimant told us, in their words.
  organization_name       TEXT NOT NULL,
  -- Nine digits when given. Nullable on purpose: the person filling this in
  -- is often a programme manager who does not have the EIN to hand, and
  -- refusing them at that point loses a claim a human could have resolved.
  ein                     TEXT
                            CHECK (ein IS NULL OR (length(ein) = 9 AND ein GLOB '[0-9]*')),
  contact_first_name      TEXT NOT NULL,
  contact_last_name       TEXT NOT NULL,
  contact_email           TEXT NOT NULL,
  contact_phone           TEXT,
  contact_job_title       TEXT,
  -- Roughly when, and roughly what for. Both free-form: a claimant who
  -- remembers "a couple of years ago, the after-school thing" is giving a
  -- reviewer everything they need, and a required year would turn that into
  -- a guess recorded as a fact.
  grant_year              INTEGER,
  grant_description       TEXT,

  -- What the system matched, at claim time. ADVISORY. Never used to grant.
  matched_organization_id TEXT REFERENCES organizations(id),
  matched_award_id        TEXT REFERENCES awards(id),

  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected')),
  decided_at              TEXT,
  decided_by              TEXT REFERENCES users(id),
  decision_note           TEXT,

  -- What approving actually produced, so the effect of a decision is on the
  -- decision rather than inferred later by matching timestamps.
  granted_user_id         TEXT REFERENCES users(id),
  granted_award_id        TEXT REFERENCES awards(id),

  submission_ip           TEXT,
  submission_user_agent   TEXT,

  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,

  -- The same shape applications uses: a decision has a decider, or there is
  -- no decision. Half a decision is not a state anyone can act on.
  CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  -- An undecided claim cannot have granted anything.
  CHECK (status <> 'pending' OR (granted_user_id IS NULL AND granted_award_id IS NULL)),
  -- An approved one must say what it granted.
  CHECK (status <> 'approved' OR (granted_user_id IS NOT NULL AND granted_award_id IS NOT NULL))
);

-- The queue. Partial, matching the query that reads it.
CREATE INDEX grantee_claims_pending_idx
  ON grantee_claims (created_at)
  WHERE status = 'pending' AND deleted_at IS NULL;

-- One outstanding claim per address. Not a uniqueness rule about people --
-- the same person may legitimately claim two grants over the years, once the
-- first is decided -- it is a rule about a public form that writes rows:
-- without it, one script files ten thousand pending claims and the queue
-- that a human reads is the thing that breaks.
CREATE UNIQUE INDEX grantee_claims_one_pending_per_email
  ON grantee_claims (contact_email)
  WHERE status = 'pending' AND deleted_at IS NULL;

CREATE INDEX grantee_claims_email_idx ON grantee_claims (contact_email);
