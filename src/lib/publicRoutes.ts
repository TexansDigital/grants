/**
 * The public front door.
 *
 * Everything before this was reachable only by someone who already held a
 * link: the eligibility screen was an API with no page, and the form
 * definition behind it was staff-only. A nonprofit could not find their way in
 * without an email from a program officer, which is not a front door.
 *
 * WHAT IS PUBLIC HERE IS NARROW AND DELIBERATE. Open cycles, and the
 * eligibility form of an open cycle. Nothing else -- no draft cycle, no
 * unpublished form, no application, no organization, no count of who has
 * applied. Each of those is a sentence somebody could learn by refreshing a
 * page, and none of them is any of the public's business.
 *
 * NO TURNSTILE ON THE READS. A challenge on a page that lists two open cycles
 * protects nothing and costs every applicant a puzzle before they have decided
 * to apply. Turnstile is on the WRITE -- the eligibility submit -- which is
 * where an automated caller could actually cost something.
 */

import type { Env } from '../types';
import { notFound } from './errors';
import { formatInZone } from './time';
import { loadFormDefinition } from './loadForm';
import { allFields, type FormDefinition } from './forms';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // A cycle can be closed by staff at any moment, and a cached "open" is
      // how somebody starts an application into a cycle that shut an hour ago.
      'cache-control': 'no-store',
    },
  });
}

/**
 * What the form ASKS, as facts rather than a guess.
 *
 * CLAUDE.md wants the public page to say how long an application takes. A
 * made-up "about 45 minutes" is a number nobody measured and everybody quotes
 * back. These are counts off the published definition: how many questions,
 * how many of them are written answers, how many documents to gather. A
 * nonprofit can judge their own evening from that, and none of it is invented.
 */
export interface FormShape {
  questions: number;
  writtenAnswers: number;
  documents: number;
}

export function describeForm(def: FormDefinition): FormShape {
  const fields = allFields(def);
  return {
    questions: fields.length,
    writtenAnswers: fields.filter((f) => f.field_type === 'long_text').length,
    documents: fields.filter((f) => f.field_type === 'file_upload').length,
  };
}

interface OpenCycleRow {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  program_id: string;
  program_name: string;
  program_description: string | null;
  guidelines_version: string | null;
  compliance_policy: string;
  form_definition_id: string | null;
  stage_name: string | null;
}

/**
 * GET /api/public/cycles — what is open right now.
 *
 * `status = 'open'` is the gate, and it is the only gate this needs. A cycle
 * in draft is invisible here; an admin opening it is the deliberate act that
 * publishes it to the world. There is no second switch, because a second
 * switch is a second thing to forget.
 *
 * The date window is checked as well as the status: a cycle left `open` past
 * its own closing date must not be advertised as accepting applications, and
 * the submit path would refuse it anyway.
 */
export async function listOpenCycles(env: Env, now: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.opens_at, c.closes_at,
            p.id AS program_id, p.name AS program_name, p.description AS program_description,
            p.guidelines_version, p.compliance_policy,
            fd.id AS form_definition_id, ps.name AS stage_name
       FROM cycles c
       JOIN programs p ON p.id = c.program_id AND p.deleted_at IS NULL
       LEFT JOIN program_stages ps
              ON ps.program_id = p.id AND ps.deleted_at IS NULL
             AND ps.sort_order = (SELECT MIN(sort_order) FROM program_stages
                                   WHERE program_id = p.id AND deleted_at IS NULL)
       LEFT JOIN form_definitions fd
              ON fd.stage_id = ps.id AND fd.status = 'published' AND fd.deleted_at IS NULL
      WHERE c.status = 'open'
        AND c.deleted_at IS NULL
        AND c.opens_at <= ?
        AND c.closes_at > ?
      ORDER BY c.closes_at`,
  )
    .bind(now, now)
    .all<OpenCycleRow>();

  const cycles = [];
  for (const c of results ?? []) {
    // A cycle whose first stage has no published form cannot be applied to,
    // so it is not advertised. Listing it would send somebody to a dead end.
    if (!c.form_definition_id) continue;

    let shape: FormShape | null = null;
    try {
      shape = describeForm(await loadFormDefinition(env.DB, c.form_definition_id));
    } catch {
      // A definition that will not load is a configuration fault, not a
      // reason to hide an open cycle from a nonprofit on deadline day.
      shape = null;
    }

    cycles.push({
      id: c.id,
      name: c.name,
      programName: c.program_name,
      programDescription: c.program_description,
      // UTC on the wire, Central for the eye. The applicant reads the same
      // string the confirmation email will give them.
      closesAt: c.closes_at,
      closesAtDisplay: formatInZone(c.closes_at, env.DISPLAY_TIMEZONE),
      opensAtDisplay: formatInZone(c.opens_at, env.DISPLAY_TIMEZONE),
      guidelinesVersion: c.guidelines_version,
      firstStageName: c.stage_name,
      formDefinitionId: c.form_definition_id,
      shape,
      /*
       * Said up front, not discovered at the end.
       *
       * A program that blocks over an unfiled report has to say so on the page
       * where somebody decides whether to spend an evening on the form -- not
       * in an email after they have filled it in.
       */
      requiresReportsFiled: c.compliance_policy === 'block',
    });
  }

  return json({ cycles });
}

/**
 * GET /api/public/forms/:id — the eligibility form of an open cycle.
 *
 * Two conditions, both required: the definition is PUBLISHED, and it belongs
 * to a program with a cycle open right now. The second is what stops this
 * becoming a way to read next year's form before it is announced, and it is
 * checked in SQL rather than after the load.
 */
export async function readPublicForm(
  env: Env,
  formDefinitionId: string,
  now: string,
): Promise<Response> {
  const allowed = await env.DB.prepare(
    `SELECT fd.id
       FROM form_definitions fd
       JOIN program_stages ps ON ps.id = fd.stage_id AND ps.deleted_at IS NULL
       JOIN cycles c ON c.program_id = fd.program_id
      WHERE fd.id = ?
        AND fd.kind = 'application'
        AND fd.status = 'published'
        AND fd.deleted_at IS NULL
        AND c.status = 'open'
        AND c.deleted_at IS NULL
        AND c.opens_at <= ?
        AND c.closes_at > ?
      LIMIT 1`,
  )
    .bind(formDefinitionId, now, now)
    .first<{ id: string }>();

  // 404, not 403. A 403 confirms the form exists, which is the one thing a
  // caller poking at ids is trying to learn.
  if (!allowed) throw notFound('form');

  return json({ form: await loadFormDefinition(env.DB, formDefinitionId) });
}
