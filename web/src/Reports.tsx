/**
 * The compliance desk: every report obligation across the portfolio.
 *
 * The question this screen exists to answer is "who owes us what, and what is
 * late" -- and then, one click later, "what did they actually say". So it is a
 * dense sortable list with the decision buttons on the detail, not a dashboard
 * of counts nobody can act on.
 *
 * Filters live in the URL, as on the pipeline and for the same reason:
 * "everything overdue in the 2026 program" becomes a link somebody can paste
 * into an email rather than a sequence of clicks described in prose.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ApiError, api } from "./api";
import type {
  BulkGenerateResult,
  ConfirmedReminderRun,
  PortfolioRow,
  ProgramRow,
  ReminderPlan,
  StaffReport,
} from "./api";
import { formatCents } from "../../src/lib/money";
import { formatDay } from "./reportWording";
import { bandsFor } from "./reportBands";
import type { BandKey } from "./reportBands";

interface Props {
  programs: ProgramRow[];
  isAdmin: boolean;
  query: string;
  onQueryChange: (next: string) => void;
  onNavigate: (path: string) => void;
}

const STATUSES = [
  "scheduled",
  "open",
  "submitted",
  "revisions_requested",
  "accepted",
  "waived",
] as const;

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  open: "Open",
  submitted: "Filed, awaiting us",
  revisions_requested: "Sent back",
  accepted: "Accepted",
  waived: "Waived",
};

export function Reports({
  programs,
  isAdmin,
  query,
  onQueryChange,
  onNavigate,
}: Props): ReactElement {
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  /*
   * THE OPEN REPORT IS IN THE ADDRESS.
   *
   * It was local state only, which made `/reporting?report=<id>` a link that
   * silently did nothing: the To Do screen and the award page both send
   * people here naming a specific report, and both landed them on the desk
   * with no indication of which row they had been sent to. On a list of
   * thirteen that is an annoyance; on a list of three hundred it is a dead
   * link. Reading it from the query also makes the report itself linkable --
   * which is what somebody forwarding "can you look at this one" needs.
   */
  const [openId, setOpenId] = useState<string | null>(() =>
    params.get("report"),
  );
  const [reloadKey, setReloadKey] = useState(0);
  const detailRef = useRef<HTMLDivElement | null>(null);
  /* The row that opened the panel, so closing it puts focus back. */
  const cameFrom = useRef<string | null>(null);

  // Follow the address when it changes under us -- a Back press, or a second
  // link arriving while this screen is already open.
  useEffect(() => {
    setOpenId(params.get("report"));
  }, [params]);

  const set = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value === "") next.delete(key);
      else next.set(key, value);
      onQueryChange(next.toString());
    },
    [onQueryChange, params],
  );

  /*
   * Opening and closing a report writes the address, so Back closes the
   * report rather than leaving the screen entirely. `set` replaces rather
   * than pushes, which is right for a filter and wrong here -- but the whole
   * screen uses replaceState, and a report that pushed while filters replaced
   * would make Back behave differently depending on what you touched last.
   * Consistency wins; the close button is the way out and it is always there.
   */
  const openReport = useCallback(
    (id: string | null) => {
      setOpenId(id);
      set("report", id ?? "");
    },
    [set],
  );

  /*
   * CLICKING A ROW APPEARED TO DO NOTHING.
   *
   * The detail panel renders after the table, so with the thirteen 2025
   * grants it opened about 1,300px down -- some 500px below the bottom of a
   * laptop window -- and the page did not move. The reader clicked a
   * nonprofit's name and watched nothing happen. At a hundred rows it is off
   * the map entirely.
   *
   * Measured, not guessed: scripts/e2e-reports.mjs asserts the panel is
   * inside the viewport after a click, which is the only form of this check
   * that cannot quietly stop being true.
   */
  useEffect(() => {
    if (!openId) return;
    const el = detailRef.current;
    if (!el) return;
    const reduce =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [openId]);

  /*
   * And closing it puts focus back on the row it came from, rather than
   * dropping a keyboard user on <body> at the top of a list they had scrolled
   * halfway down. Queried after the next frame because the list re-renders
   * when a decision reloads it, which can take the original element away --
   * hence the fall back to the screen's own heading.
   */
  const closeReport = useCallback(() => {
    const id = cameFrom.current;
    openReport(null);
    requestAnimationFrame(() => {
      const sel = id ? `[data-report-row="${id}"]` : null;
      const back = sel ? document.querySelector<HTMLElement>(sel) : null;
      (
        back ?? document.querySelector<HTMLElement>("[data-route-heading]")
      )?.focus();
    });
  }, [openReport]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .reports(params.toString(), controller.signal)
      .then((out) => {
        setRows(out.rows);
        setTotal(out.total);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(
          e instanceof ApiError
            ? e
            : new ApiError(0, "INTERNAL", String(e), null),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [params, reloadKey]);

  const bands = useMemo(() => bandsFor(rows), [rows]);

  return (
    <>
      <div className="panel-head">
        <h2 tabIndex={-1} data-route-heading>
          Grant reports
        </h2>
        <p className="meta" aria-live="polite">
          {loading
            ? "Loading…"
            : /*
               * "13 of 118" is the only honest way to say a list is cut short,
               * and this one is: the endpoint pages and this screen does not.
               * When it is showing everything it says so by not counting
               * twice.
               */
              rows.length === total
              ? `${total} obligation${total === 1 ? "" : "s"}`
              : `${rows.length} of ${total} obligations`}
        </p>
      </div>

      <div className="filters">
        {/*
          A <div> wrapping a real <label for>, which is the shape every other
          screen uses and the shape `.filter label` in internal.css actually
          styles. This screen was the last one still writing
          `<label class="filter"><span>`, which matched no rule at all -- so
          its three captions fell through to 16px body text, larger than the
          column headings and every value in the table, sitting beside their
          controls instead of above them. One screen's filters looking unlike
          every other screen's was the whole of it.
        */}
        <div className="filter">
          <label htmlFor="reports-program">Program</label>
          <select
            id="reports-program"
            value={params.get("program_id") ?? ""}
            onChange={(e) => set("program_id", e.target.value)}
          >
            <option value="">All programs</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="filter">
          <label htmlFor="reports-status">Status</label>
          <select
            id="reports-status"
            value={params.get("status") ?? ""}
            onChange={(e) => set("status", e.target.value)}
          >
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="filter">
          <label htmlFor="reports-overdue">Overdue only</label>
          <select
            id="reports-overdue"
            value={params.get("overdue") ?? ""}
            onChange={(e) => set("overdue", e.target.value)}
          >
            <option value="">No</option>
            <option value="true">Yes</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="banner danger" role="alert">
          {error.message}
        </p>
      )}

      {!loading && rows.length === 0 && !error && (
        <p className="empty">Nothing matches these filters.</p>
      )}

      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="banded">
            <caption className="sr-only">
              Report obligations across every grant, grouped by who is holding
              them up
            </caption>
            <thead>
              <tr>
                <th scope="col">Organization</th>
                <th scope="col">Report</th>
                <th scope="col">Due</th>
                <th scope="col">Status</th>
                {/* "Chased" was blunt in a way that reads badly in a screenshot
                    or an export. It is the same column. */}
                <th scope="col">Reminders</th>
                <th scope="col">Award</th>
                <th scope="col">Spent</th>
              </tr>
            </thead>
            {bands.map((band) => (
              <tbody key={band.key} data-band={band.key}>
                {/*
                  A heading row rather than four separate tables: one set of
                  column headings, one set of column widths, and the bands
                  read as parts of one list instead of four lists that happen
                  to share a shape. `scope="colgroup"` is what a row-spanning
                  heading inside a grouped table is for.
                */}
                <tr className="band">
                  <th colSpan={7} scope="colgroup">
                    <span className="band-name">{band.heading}</span>
                    <span className="count">{band.rows.length}</span>
                    <span className="band-blurb">{band.blurb}</span>
                  </th>
                </tr>
                {band.rows.map((r) => (
                  <ReportRow
                    key={r.reportPeriodId}
                    row={r}
                    band={band.key}
                    onOpen={() => {
                      cameFrom.current = r.reportPeriodId;
                      openReport(r.reportPeriodId);
                    }}
                    onNavigate={onNavigate}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      <div ref={detailRef}>
        {openId && (
          <ReportDetail
            reportPeriodId={openId}
            isAdmin={isAdmin}
            onClose={closeReport}
            onDecided={() => {
              closeReport();
              setReloadKey((n) => n + 1);
            }}
          />
        )}
      </div>

      {/*
        LAST, not first. This is pressed once after an import and then never
        again, and it led the screen -- above the filters and above the data,
        the first thing under the heading, with a rule above and below it and
        nothing in between. Housekeeping belongs at the bottom of the room.
      */}
      {isAdmin && <TonightsReminders />}
      {isAdmin && <GeneratePeriods />}
    </>
  );
}

/**
 * One obligation.
 *
 * The band decides what the Due cell says underneath the date, because the
 * same number means different things: a report nobody has filed is late, and
 * a report sitting in our queue was filed -- and saying "8 days late" next to
 * one we are already holding blames the nonprofit for our backlog.
 */
function ReportRow({
  row: r,
  band,
  onOpen,
  onNavigate,
}: {
  row: PortfolioRow;
  band: BandKey;
  onOpen: () => void;
  onNavigate: (path: string) => void;
}): ReactElement {
  return (
    <tr>
      <td>
        <button
          type="button"
          className="rowlink"
          data-report-row={r.reportPeriodId}
          onClick={onOpen}
        >
          {r.organizationName}
        </button>
        <span className="meta">{r.programName}</span>
      </td>
      <td>{r.label}</td>
      <td>
        {formatDay(r.dueDate)}
        {band === "late" && (
          <span className="meta strong" data-overdue="true">
            {Math.abs(r.daysUntilDue)} day
            {Math.abs(r.daysUntilDue) === 1 ? "" : "s"} late
          </span>
        )}
        {band === "ours" && r.submittedAt && (
          <span className="meta">Filed {formatDay(r.submittedAt)}</span>
        )}
      </td>
      <td>
        {/* `badge-report` scopes the weight to this screen. The status values
            collide with application statuses -- `submitted` means "sent to us"
            on both -- and the two screens want opposite emphasis from it. */}
        <span className={`badge badge-report badge-${r.status}`}>
          {STATUS_LABEL[r.status] ?? r.status}
        </span>
      </td>
      <td>
        {/*
          HAVE WE ASKED? An overdue row on its own is ambiguous between a
          nonprofit ignoring us and a nonprofit nobody ever contacted, and
          those call for opposite conversations. "Not yet" next to a red date
          is the Foundation's problem, not the grantee's.
        */}
        {r.reminderCount === 0 ? (
          band === "late" ? (
            <span className="meta strong" data-overdue="true">
              Not yet
            </span>
          ) : (
            <span className="meta">&mdash;</span>
          )
        ) : (
          <>
            {r.reminderCount}
            {r.reminderLastSentAt && (
              <span className="meta">{formatDay(r.reminderLastSentAt)}</span>
            )}
          </>
        )}
      </td>
      <td className="num">
        {/*
          THE AMOUNT IS THE WAY TO THE GRANT. The award page is where the
          paperwork, the payment schedule and the amendment form live, and
          until it existed there was no route to any of them for an imported
          grant. The row already names the amount; making it the link costs a
          column nothing.
        */}
        <button
          type="button"
          className="rowlink"
          aria-label={`Open the grant for ${r.organizationName}`}
          onClick={() => onNavigate(`/awards/${r.awardId}`)}
        >
          {formatCents(r.awardedAmountCents)}
        </button>
      </td>
      <td className="num">
        {r.fundsSpentCents === null ? "—" : formatCents(r.fundsSpentCents)}
      </td>
    </tr>
  );
}

type Decision =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "error"; message: string };

function ReportDetail({
  reportPeriodId,
  isAdmin,
  onClose,
  onDecided,
}: {
  reportPeriodId: string;
  isAdmin: boolean;
  onClose: () => void;
  onDecided: () => void;
}): ReactElement {
  const [data, setData] = useState<StaffReport | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [feedback, setFeedback] = useState("");
  const [decision, setDecision] = useState<Decision>({ kind: "idle" });
  const [fetching, setFetching] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  /*
   * The panel takes focus the moment it opens.
   *
   * Scrolling it into view fixes the mouse; without this the keyboard is
   * still standing on the row behind it, so Tab walks the rest of the table
   * rather than the thing that just appeared. preventScroll because the
   * positioning is the parent's job -- a focus() that also scrolled would
   * fight the smooth scroll and land somewhere neither of them chose.
   *
   * On mount, which means on the LOADING panel: React reconciles that
   * <section> with the loaded one, so focus stays where it was put rather
   * than jumping once the fetch returns -- a focus move that happens half a
   * second after the click is more disorienting than no move at all.
   */
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  /*
   * Open a file a grantee attached.
   *
   * This screen listed filenames and sizes as plain text, so a reviewer could
   * see that three photographs existed and had no way to look at any of them.
   * The endpoint has been there since 0017; this view simply never called it.
   *
   * Same shape as ApplicationDetail: the Worker mints a short-lived signed URL
   * and the browser navigates to it. R2's Content-Disposition makes that a
   * save rather than a navigation, so the tab closes itself.
   */
  async function download(attachmentId: string): Promise<void> {
    setFetching(attachmentId);
    setDownloadError(null);
    try {
      const grant = await api.downloadUrl(attachmentId);
      window.location.assign(grant.url);
    } catch (e) {
      setDownloadError(
        e instanceof ApiError
          ? e.message
          : "That file could not be opened. Try again.",
      );
    } finally {
      setFetching(null);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    api
      .report(reportPeriodId, controller.signal)
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(
          e instanceof ApiError
            ? e
            : new ApiError(0, "INTERNAL", String(e), null),
        );
      });
    return () => controller.abort();
  }, [reportPeriodId]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setDecision({ kind: "working" });
      try {
        await fn();
        onDecided();
      } catch (e) {
        setDecision({
          kind: "error",
          message:
            e instanceof ApiError
              ? e.message
              : "That did not go through. Try again.",
        });
      }
    },
    [onDecided],
  );

  if (error) {
    return (
      <section
        className="panel"
        ref={panelRef}
        tabIndex={-1}
        aria-label="Report"
      >
        <p className="banner danger" role="alert">
          {error.message}
        </p>
      </section>
    );
  }
  if (!data) {
    return (
      <section
        className="panel"
        ref={panelRef}
        tabIndex={-1}
        aria-label="Report"
      >
        <p className="meta">Loading…</p>
      </section>
    );
  }

  const latest = data.submissions[0] ?? null;
  const canDecide = isAdmin && data.period.status === "submitted";
  /*
   * A settled deadline does not move: `accepted` and `waived` are terminal and
   * their due date is part of what the grantee was held to. The server and
   * 0029 both refuse it; this keeps the control from appearing at all, so
   * nobody is offered a door that answers with an error.
   */
  /*
   * `?? []` because a blank is the normal state here and a crash is not. This
   * screen went blank when a payload arrived without the field -- a browser
   * left open across a deploy, or any caller older than the server. CLAUDE.md:
   * empty values degrade gracefully everywhere.
   */
  const dueDateChanges = data.dueDateChanges ?? [];
  const canMove =
    isAdmin &&
    data.period.status !== "accepted" &&
    data.period.status !== "waived";
  const canWaive =
    isAdmin &&
    data.period.status !== "accepted" &&
    data.period.status !== "waived";

  return (
    <section
      className="panel"
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="report-detail-heading"
    >
      <div className="panel-head">
        <h3 id="report-detail-heading">
          {data.award.organizationName} — {data.period.label}
        </h3>
        <button type="button" className="btn secondary small" onClick={onClose}>
          Close
        </button>
      </div>

      <dl className="facts">
        <div>
          <dt>Program</dt>
          <dd>{data.award.programName}</dd>
        </div>
        <div>
          <dt>Award</dt>
          <dd>{formatCents(data.award.awardedAmountCents)}</dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>
            {formatDay(data.period.dueDate)}
            {/*
              A moved deadline is said HERE, beside the date, not only further
              down. Somebody deciding whether a nonprofit is late reads this
              line and nothing else, and "due 30 November" on a report that was
              originally due in September is not the whole truth.
            */}
            {dueDateChanges.length > 0 && (
              <span className="meta">
                {" "}
                moved {dueDateChanges.length}&times; from{" "}
                {formatDay(dueDateChanges[0]!.oldValue ?? "")}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{STATUS_LABEL[data.period.status] ?? data.period.status}</dd>
        </div>
      </dl>

      {data.period.waivedReason && (
        <p className="banner">
          <strong>Waived:</strong> {data.period.waivedReason}
        </p>
      )}

      {/*
        WHY THE DEADLINE MOVED, in full.
        
        An extension without its reason is worse than no record: it looks like
        the date was always this, and the next person to read the file cannot
        tell a nonprofit who asked for help from one who was simply given
        longer. Named, dated, reasoned -- the same three things an award
        amendment carries.
      */}
      {dueDateChanges.length > 0 && (
        <ul className="findings">
          {dueDateChanges.map((c) => (
            <li key={c.id}>
              <span className="who">
                {formatDay(c.oldValue ?? "")} &rarr;{" "}
                {formatDay(c.newValue ?? "")}
              </span>
              <span className="what">
                {c.reason} &mdash; {c.amendedBy}, {formatDay(c.amendedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {data.submissions.length === 0 && (
        <p className="empty">Nothing has been filed against this report yet.</p>
      )}

      {data.submissions.map((s, i) => (
        <article key={s.id} className="review-section">
          <div className="review-head">
            <h4>
              {i === 0 && data.submissions.length > 1
                ? "Latest attempt"
                : `Filed ${formatDay(s.submittedAt)}`}
            </h4>
            <span className="meta">
              {s.submittedBy ?? "unknown"}
              {s.acceptedAt && " · accepted"}
            </span>
          </div>

          {s.adminFeedback && (
            <p className="banner">
              <strong>We asked for:</strong> {s.adminFeedback}
            </p>
          )}

          {/*
           * NUMBERS GET THE BIG TREATMENT. PROSE DOES NOT.
           *
           * Every metric used to render at display scale, so "Enriched
           * wishes" and "Ethernet" were typeset like headline figures beside
           * "500 people". The brand's stat tile is for an abbreviated figure
           * under a short label; a sentence in that slot reads as a mistake,
           * because it is one.
           *
           * Text metrics are not dropped -- they fall through to the list
           * below with the narrative answers, which is where a sentence
           * belongs.
           */}
          {s.metrics.some((m) => m.metricType !== "text") && (
            /*
              ITS OWN BAND, with a rule under it.
              The tiles and the answer list ran into each other: measured in a
              browser, the bottom of "1,240" and the top of the first answer
              were at the same y -- zero pixels apart -- so a 34px figure and a
              13px label sat in one block with nothing to say which belonged to
              which. The reader had to work out that "What the grant paid for"
              was not a caption for the number above it.
            */
            <dl className="facts report-metrics">
              {s.metrics
                .filter((m) => m.metricType !== "text")
                .map((m) => (
                  <div key={m.metricKey}>
                    <dt>{m.label}</dt>
                    <dd className="bignum">{m.display ?? "—"}</dd>
                  </div>
                ))}
            </dl>
          )}

          {/*
           * Everything the grantee wrote, ONCE.
           *
           * A metric is also a form field, so every number appeared twice:
           * as a tile above and again in this list. The tiles are the
           * canonical rendering for the numeric ones, so those are dropped
           * here. Metric-backed fields carry the METRIC_FIELD_PREFIX, which
           * is how a field that came from a metric is told apart from one
           * somebody wrote into the form.
           */}
          {/*
            THE LABEL SITS ABOVE ITS ANSWER, not 405px to the left of it.

            `.review-list` lays label and value in a 1fr/2fr pair, which is
            right on the applicant's review-before-submit screen where most
            answers are a word or a figure. Here every answer is a paragraph,
            so a thirteen-character label held a 405px column open beside it
            and the prose began a third of the way across the panel. Measured,
            not guessed. A separate class rather than a change to
            `.review-list`, because the applicant screen is a different
            surface and this is not an improvement there.
          */}
          <dl className="report-answers">
            {s.answers
              .filter((a) => {
                if (!a.fieldKey.startsWith("metric_")) return true;
                const key = a.fieldKey.slice("metric_".length);
                const metric = s.metrics.find((m) => m.metricKey === key);
                // Shown above as a tile, unless it is prose, which is not.
                return !metric || metric.metricType === "text";
              })
              .map((a) => (
                <div className="report-answer" key={a.fieldKey}>
                  <dt>{a.label}</dt>
                  <dd>
                    {/*
                      EMPTY STRING IS NOT ANSWERED EITHER. `??` only catches
                      null, and a field a grantee skipped comes back as '' --
                      so the label rendered with nothing under it at all. The
                      attachment box below then slid up against it and the
                      label read as though it belonged to the PDF. CLAUDE.md:
                      "No dangling labels, no orphan bullets."
                    */}
                    {a.display === null || a.display === "" ? (
                      <span className="meta">Not answered</span>
                    ) : (
                      a.display
                    )}
                  </dd>
                </div>
              ))}
          </dl>

          {s.attachments.length > 0 && (
            <div className="report-files">
              {/*
                A rule and a name. The file boxes butted straight onto the last
                answer, so the label above them read as their caption -- which
                it was not -- and there was nothing to say these came from the
                grantee rather than from us.
              */}
              <h5>What they attached</h5>
              <ul className="upload-list">
                {s.attachments.map((f) => (
                  <li key={f.id}>
                    <span className="upload-name">{f.filename}</span>
                    <span className="upload-size">
                      {Math.round(f.sizeBytes / 1024)} KB
                    </span>
                    <button
                      type="button"
                      className="btn secondary small"
                      disabled={fetching === f.id}
                      onClick={() => void download(f.id)}
                    >
                      {fetching === f.id ? "Preparing…" : "Open"}
                    </button>
                  </li>
                ))}
              </ul>
              {downloadError && (
                <p className="banner danger" role="alert">
                  {downloadError}
                </p>
              )}
            </div>
          )}
        </article>
      ))}

      {decision.kind === "error" && (
        <p className="banner danger" role="alert">
          {decision.message}
        </p>
      )}

      {canMove && (
        <MoveDueDate
          reportPeriodId={reportPeriodId}
          currentDueDate={data.period.dueDate}
          onMoved={onDecided}
        />
      )}

      {canDecide && latest && (
        <div className="panel-decide">
          {/*
            The last of the mismatched filter captions. As a bare <span> inside
            `label.filter` it rendered at 16px on the textarea's bottom
            baseline, overlapping the control's left edge -- a caption sitting
            ON the box it labels. Same shape as the filters above now.
          */}
          <div className="filter">
            {/* Deliberately above both buttons, and required by the server for
                the send-back. A nonprofit cannot act on "changes requested". */}
            <label htmlFor="report-feedback">
              What needs to change, if anything
            </label>
            <textarea
              id="report-feedback"
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Please break the spend out by site."
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={decision.kind === "working"}
              onClick={() => act(() => api.acceptReport(reportPeriodId))}
            >
              Accept this report
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={
                decision.kind === "working" || feedback.trim().length < 10
              }
              onClick={() =>
                act(() => api.requestReportRevisions(reportPeriodId, feedback))
              }
            >
              Send back with these notes
            </button>
          </div>
        </div>
      )}

      {canWaive && (
        <div className="danger-row">
          <button
            type="button"
            className="linklike danger"
            disabled={decision.kind === "working"}
            onClick={() => {
              const reason = window.prompt("Why is this report not required?");
              if (reason && reason.trim().length >= 5) {
                void act(() => api.waiveReport(reportPeriodId, reason));
              }
            }}
          >
            Waive this report
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Create the report obligations for grants that have none.
 *
 * WHY THIS BUTTON EXISTS AT ALL. Until it did, nothing in the running system
 * could produce a report period. The generator was written and tested in
 * Phase 5 and reachable from nowhere, so an imported grant was a grant nobody
 * would ever be asked to report on -- the portal lists periods, this desk
 * lists periods, and an award with none appeared in neither. The data health
 * check that counts them was the only thing that knew.
 *
 * It sits here rather than on the health screen because this is where the
 * person who manages report obligations already works, and because health
 * stays read-only: it diagnoses, this acts.
 *
 * Safe to press twice. The generator refuses an award that already has
 * periods rather than merging into it -- once a grantee has been told a date,
 * regenerating could move it.
 */
function GeneratePeriods(): ReactElement {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "working" }
    | { kind: "done"; result: BulkGenerateResult }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const run = useCallback(async () => {
    const ok = window.confirm(
      "Create report obligations for every grant that has none? " +
        "Grantees will be asked to file on the dates this works out.",
    );
    if (!ok) return;
    setState({ kind: "working" });
    try {
      setState({ kind: "done", result: await api.generateReportPeriods() });
    } catch (e) {
      setState({
        kind: "error",
        message:
          e instanceof ApiError
            ? e.message
            : "That did not go through. Try again.",
      });
    }
  }, []);

  return (
    <div className="panel-decide">
      <div className="actions">
        <button
          type="button"
          className="btn secondary small"
          disabled={state.kind === "working"}
          onClick={run}
        >
          {state.kind === "working"
            ? "Working…"
            : "Create missing report obligations"}
        </button>
      </div>

      {state.kind === "error" && (
        <p className="banner danger" role="alert">
          {state.message}
        </p>
      )}

      {state.kind === "done" && (
        <div role="status">
          <p className="meta">
            {state.result.periodsCreated === 0
              ? "Nothing to do — every grant with a term already has its report obligations."
              : `Created ${state.result.periodsCreated} report obligation` +
                `${state.result.periodsCreated === 1 ? "" : "s"} across ` +
                `${state.result.generated.length} grant` +
                `${state.result.generated.length === 1 ? "" : "s"}. Reload to see them.`}
          </p>
          {state.result.skipped.length > 0 && (
            <ul className="tally">
              {state.result.skipped.map((s) => (
                <li key={s.awardId}>
                  <span className="meta strong" data-overdue="true">
                    {s.skipped}
                  </span>
                  <span className="ref">{s.awardId.slice(0, 8)}</span>
                </li>
              ))}
            </ul>
          )}
          {state.result.more && (
            <p className="meta">
              More grants still need obligations than one run will take. Press
              it again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * MOVING A REPORT'S DUE DATE.
 *
 * Until this existed, nothing in the system could change a due date. Staff
 * could accept a report, ask for revisions, or waive it entirely -- so a
 * nonprofit asking for two more weeks got no answer, because there was none to
 * give short of editing the database by hand.
 *
 * COLLAPSED BY DEFAULT. Extending a deadline is rare and consequential, and a
 * date field sitting permanently open beside a report invites a stray edit to
 * something a nonprofit has already been told.
 *
 * THE REASON IS A FIELD, NOT A CONFIRMATION. A dialog asking "are you sure"
 * collects nothing; the reason is the entire content of an extension, because
 * the new date is already on the record. The server refuses a move without
 * one, and 0029 refuses the write at the database, so this is the third of
 * three places that agree rather than the only one.
 */
function MoveDueDate({
  reportPeriodId,
  currentDueDate,
  onMoved,
}: {
  reportPeriodId: string;
  currentDueDate: string;
  onMoved: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "working" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  /*
   * Tomorrow, as the earliest selectable day. The server refuses today or
   * earlier -- a past due date is a born-overdue obligation -- and `min` means
   * the picker says so before a submit rather than after.
   */
  const tomorrow = useMemo(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }, []);

  const submit = useCallback(async () => {
    setState({ kind: "working" });
    try {
      await api.moveReportDueDate(reportPeriodId, date, reason);
      setOpen(false);
      setDate("");
      setReason("");
      setState({ kind: "idle" });
      onMoved();
    } catch (e) {
      setState({
        kind: "error",
        message:
          e instanceof ApiError
            ? e.message
            : "That did not go through. Try again.",
      });
    }
  }, [date, reason, reportPeriodId, onMoved]);

  if (!open) {
    return (
      <div className="panel-decide">
        <div className="actions">
          <button
            type="button"
            className="btn secondary small"
            onClick={() => setOpen(true)}
          >
            Change the due date
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-decide">
      <div className="filter">
        <label htmlFor="move-due-date">
          New due date (currently {formatDay(currentDueDate)})
        </label>
        <input
          id="move-due-date"
          type="date"
          min={tomorrow}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <div className="filter">
        {/* Required by the server, and the only part of this that will still
            mean anything in a year. */}
        <label htmlFor="move-due-reason">Why it is moving</label>
        <textarea
          id="move-due-reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      {state.kind === "error" && (
        <p className="banner danger" role="alert">
          {state.message}
        </p>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn small"
          disabled={
            state.kind === "working" || !date || reason.trim().length < 5
          }
          onClick={() => void submit()}
        >
          {state.kind === "working" ? "Saving\u2026" : "Move the due date"}
        </button>
        <button
          type="button"
          className="btn secondary small"
          disabled={state.kind === "working"}
          onClick={() => {
            setOpen(false);
            setState({ kind: "idle" });
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * WHAT TONIGHT'S REMINDERS WILL DO, AND SENDING THEM NOW.
 *
 * The reminder job only ever ran from cron at 07:00, so the only way to find
 * out what it would do was to let it do it -- to a few hundred nonprofits who
 * did not ask. This is the panel that answers it first.
 *
 * TWO STEPS, THE SAME SHAPE AS THE UPDATE REQUEST. Showing the plan writes
 * nothing: no letter, no message row, no error row, no reminder stamp. Sending
 * is a second, deliberate press.
 *
 * THE COUNT IT SENDS IS THE COUNT IT SHOWED. `expectLetters` comes from the
 * plan in state, never from a fresh fetch -- a fresh one would agree with the
 * server by construction and defeat the check entirely. If the ground has
 * moved since the plan was read, the server refuses and says by how much.
 *
 * It lists the actual addresses rather than a number. A count cannot be
 * checked against intent; "one letter, to the mailbox I control" can.
 */
function TonightsReminders(): ReactElement {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "plan"; plan: ReminderPlan }
    | { kind: "sending"; plan: ReminderPlan }
    | { kind: "sent"; run: ConfirmedReminderRun }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "plan", plan: await api.reminderPlan() });
    } catch (e) {
      setState({
        kind: "error",
        message:
          e instanceof ApiError
            ? e.message
            : "Could not work out tonight\u2019s reminders.",
      });
    }
  }, []);

  const send = useCallback(async (plan: ReminderPlan) => {
    const addresses = plan.wouldMail.flatMap((o) => o.recipients);
    const ok = window.confirm(
      `Send ${plan.lettersWouldSend} reminder${plan.lettersWouldSend === 1 ? "" : "s"} now, to:\n\n` +
        `${addresses.join("\n")}\n\n` +
        "This cannot be unsent.",
    );
    if (!ok) return;
    setState({ kind: "sending", plan });
    try {
      // The count the panel DISPLAYED. See the note above.
      setState({
        kind: "sent",
        run: await api.runRemindersNow(plan.lettersWouldSend),
      });
    } catch (e) {
      setState({
        kind: "error",
        message:
          e instanceof ApiError
            ? e.message
            : "That did not go through. Nothing was sent.",
      });
    }
  }, []);

  const plan =
    state.kind === "plan" || state.kind === "sending" ? state.plan : null;

  return (
    <div className="panel-decide">
      <div className="actions">
        <button
          type="button"
          className="btn secondary small"
          disabled={state.kind === "loading" || state.kind === "sending"}
          onClick={load}
        >
          {state.kind === "loading"
            ? "Working\u2026"
            : "Show what tonight\u2019s reminders will do"}
        </button>
        {plan && plan.lettersWouldSend > 0 && (
          <button
            type="button"
            className="btn small"
            disabled={state.kind === "sending"}
            onClick={() => void send(plan)}
          >
            {state.kind === "sending"
              ? "Sending\u2026"
              : `Send ${plan.lettersWouldSend} now`}
          </button>
        )}
      </div>

      {state.kind === "error" && (
        <p className="banner danger" role="alert">
          {state.message}
        </p>
      )}

      {plan && (
        <div role="status">
          <p className="meta">
            {plan.lettersWouldSend === 0
              ? "Nobody is due a reminder today. Reminders go out 14 days before a " +
                "report is due, 3 days before, on the day, and weekly once it is late."
              : `${plan.lettersWouldSend} letter${plan.lettersWouldSend === 1 ? "" : "s"} to ` +
                `${plan.wouldMail.length} organization${plan.wouldMail.length === 1 ? "" : "s"}. ` +
                "Nothing has been sent."}
          </p>

          {/*
            An empty inbox after a confirmed send is otherwise unexplainable:
            with no provider configured every message is RECORDED and nothing
            leaves. Said before the send, not after.
          */}
          {!plan.transportConfigured && (
            <p className="banner" role="alert">
              No email provider is configured, so nothing would actually arrive.
              Each message would be recorded as suppressed.
            </p>
          )}

          {plan.wouldMail.length > 0 && (
            <ul className="findings">
              {plan.wouldMail.map((o) => (
                <li key={o.organizationId}>
                  <span className="who">{o.organizationName}</span>
                  <span className="what">
                    {o.recipients.join(", ")} &mdash;{" "}
                    {o.reports
                      .map((r) => `${r.label} (${dueWording(r.daysUntilDue)})`)
                      .join("; ")}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/*
            Due today with nobody to write to. The real run logs this and
            nothing shows it; here it is beside the sends, because it is the
            reason a report will go overdue with no explanation.
          */}
          {plan.withNoContact.length > 0 && (
            <>
              <p className="meta strong" data-overdue="true">
                Due today, and no grantee account to write to
              </p>
              <ul className="findings">
                {plan.withNoContact.map((o) => (
                  <li key={o.organizationId}>
                    <span className="who">{o.organizationName}</span>
                    <span className="what">
                      {o.reports.map((r) => r.label).join("; ")} &mdash; nobody
                      can be reached
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {state.kind === "sent" && (
        <div role="status">
          <p className="meta">
            {state.run.granteesMailed} sent, {state.run.suppressed} suppressed,{" "}
            {state.run.failed} refused by the provider.
            {state.run.deduplicated > 0 &&
              ` ${state.run.deduplicated} had already been written to today, so nothing
                was sent to them again.`}
            {state.run.withNoContact > 0 &&
              ` ${state.run.withNoContact} report${
                state.run.withNoContact === 1 ? "" : "s"
              } had nobody to write to.`}
          </p>
          {state.run.failed > 0 && (
            <p className="banner danger" role="alert">
              The provider refused {state.run.failed}. Those grantees were not
              reached &mdash; Data health lists them under recorded errors.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "in 14 days", "today", "8 days late".
 *
 * The sign carries the meaning and a bare number loses it: "14" beside a
 * report that is a fortnight overdue reads as a fortnight of slack.
 */
function dueWording(daysUntilDue: number): string {
  if (daysUntilDue === 0) return "due today";
  if (daysUntilDue > 0)
    return `due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}`;
  const late = -daysUntilDue;
  return `${late} day${late === 1 ? "" : "s"} late`;
}
