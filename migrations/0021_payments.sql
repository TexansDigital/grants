-- 0021_payments.sql
--
-- The payment ledger.
--
-- WHAT THIS IS AND, MUCH MORE IMPORTANTLY, WHAT IT IS NOT. CLAUDE.md:
-- "The system does not disburse money. It records schedules and status.
-- Disbursement stays with finance." Nothing here moves a cent. This table is a
-- record of what was agreed, what finance says has gone out, and the gap
-- between them -- which is the question the dashboard has been unable to
-- answer since it was built, and says so on every screen.
--
-- WHY IT WAS DEFERRED AND WHY NOW. 0012 deliberately left payments out: the
-- vocabulary was a guess and the schema had taught nobody anything yet. It has
-- now. Awards have terms, acceptance is a real event, and the dashboard has a
-- hole shaped exactly like this table.
--
-- MONEY IS INTEGER CENTS, with the same ceiling and the same typeof() guard as
-- awards. The guard is worth restating rather than assuming: SQLite applies
-- INTEGER affinity BEFORE the CHECK and only when lossless, so 2500.5 stays
-- REAL and is refused, '2500.5' and 'abc' stay TEXT and are refused, and
-- '2500000' converts to a real integer and is accepted. It stops a float or an
-- unparseable value reaching a money column; it is not a type check on what the
-- caller passed.
--
-- A PAYMENT BELONGS TO AN AWARD, not to an application or an organization. The
-- award is what carries the amount, the term and the acceptance; paying against
-- anything else would let a payment exist with no agreed sum behind it.

CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  award_id          TEXT NOT NULL REFERENCES awards(id),

  amount_cents      INTEGER NOT NULL
                      CHECK (typeof(amount_cents) = 'integer'
                             AND amount_cents > 0
                             AND amount_cents <= 10000000000),

  -- When it is meant to go. Required: a payment with no date is a wish.
  scheduled_date    TEXT NOT NULL,
  -- When finance says it went. NULL until they do.
  paid_date         TEXT,

  --   scheduled - agreed, not yet paid
  --   paid      - finance has confirmed it left. Terminal.
  --   cancelled - not going to happen. NOT a delete; the row stays, because
  --               "we promised this and then did not" is the question an
  --               auditor asks and a deleted row cannot answer.
  status            TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','paid','cancelled')),

  -- How, and the reference finance can look up. Free text on purpose: the
  -- vocabulary belongs to whatever system cuts the cheque, and a CHECK here
  -- would be this project guessing at somebody else's enum.
  method            TEXT,
  reference_number  TEXT,

  note              TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,

  -- Paid and a paid date arrive together, or neither does. A payment marked
  -- paid with no date cannot answer "when", which is the whole point of
  -- recording it.
  CHECK ((status = 'paid') = (paid_date IS NOT NULL)),
  -- A cancellation says why. "Cancelled" with nothing behind it is a gap
  -- exactly where somebody asks what happened to the money.
  CHECK (status <> 'cancelled' OR (note IS NOT NULL AND TRIM(note) <> ''))
);

CREATE INDEX payments_award_idx ON payments (award_id) WHERE deleted_at IS NULL;
-- "What is due, and when." The schedule view and the disbursed total both ride
-- on this.
CREATE INDEX payments_due_idx
  ON payments (scheduled_date)
  WHERE status = 'scheduled' AND deleted_at IS NULL;

-- A payment cannot be scheduled against an award that does not exist or has
-- been removed. A foreign key covers the first; this covers the second, which
-- a foreign key does not, because a soft delete leaves the row in place.
CREATE TRIGGER payments_award_must_be_live_insert
BEFORE INSERT ON payments
WHEN NOT EXISTS (
  SELECT 1 FROM awards WHERE id = NEW.award_id AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'a payment must belong to a live award');
END;

-- A paid payment is settled. Changing its amount afterwards would rewrite
-- what finance has already sent, and the disbursed total with it.
CREATE TRIGGER payments_paid_amount_is_settled
BEFORE UPDATE OF amount_cents ON payments
WHEN OLD.status = 'paid' AND NEW.amount_cents IS NOT OLD.amount_cents
BEGIN
  SELECT RAISE(ABORT, 'a paid payment cannot have its amount changed');
END;
