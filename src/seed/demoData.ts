/**
 * Invented demo data, at the volume this system actually sees.
 *
 * WHY THIS EXISTS. The staff pipeline, the full-text search and the applicant
 * history panel have never been looked at with more than a handful of rows in
 * front of them. CLAUDE.md sizes the real thing at 100-400 applications a year
 * across programs, and the interesting problems -- a filter that is useless at
 * 200 rows, a search that returns everything, a history panel that is a wall
 * -- only appear at that size. Three fixtures cannot show them.
 *
 * EVERYTHING HERE IS INVENTED, per CLAUDE.md: fake EINs, invented organization
 * names built from a word list, narratives assembled from templates. No row is
 * derived from a real applicant. Real past applications go to STAGING and never
 * near this file (decision 18).
 *
 * DETERMINISTIC. A seeded PRNG, so the same call produces the same database
 * every time. A demo dataset that shuffles on every run cannot be used to
 * reproduce a bug someone reported from it.
 */

import type { RequestContext } from '../types';
import { newId } from '../lib/ids';
import { normalizeEin } from '../lib/ein';

/**
 * Mulberry32. Small, fast, and good enough for choosing names -- this seeds a
 * demo database, it is not a source of anything security-relevant. Tokens come
 * from crypto.getRandomValues; nothing here ever touches a credential.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const int = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

// Word lists chosen to produce names that read like real Houston nonprofits
// without being any of them. Every combination is checked against nothing,
// deliberately -- if one collides with a real organization it is coincidence,
// and the EINs and addresses are unmistakably fake.
const PLACES = [
  'Bayou', 'Third Ward', 'Gulf Coast', 'Buffalo Bayou', 'East End', 'Sunnyside',
  'Acres Homes', 'Alief', 'Sharpstown', 'Northside', 'Magnolia Park', 'Kashmere',
  'Independence Heights', 'Greater Fifth Ward', 'Pasadena', 'Baytown', 'Katy Prairie',
  'Clear Lake', 'Spring Branch', 'Gulfton',
];
const THEMES = [
  'Literacy', 'Futures', 'Wellness', 'Opportunity', 'Reentry', 'Harvest',
  'Bridge', 'Compass', 'Lantern', 'Foundry', 'Trellis', 'Anchor',
  'Cornerstone', 'Beacon', 'Threshold', 'Keystone',
];
const SUFFIXES = [
  'Collective', 'Alliance', 'Project', 'Initiative', 'Coalition', 'Partnership',
  'Center', 'Network', 'Fund', 'Institute',
];

const FIRST = [
  'Alex', 'Robin', 'Sam', 'Jordan', 'Priya', 'Marcus', 'Elena', 'Tomas', 'Nia',
  'Devon', 'Camille', 'Isaiah', 'Rosa', 'Hana', 'Bennett', 'Yolanda', 'Andre', 'Simone',
];
const LAST = [
  'Moreno', 'Okafor', 'Delacroix', 'Nguyen', 'Patel', 'Whitfield', 'Alvarez', 'Boone',
  'Castellanos', 'Ferreira', 'Mbeki', 'Sandoval', 'Reyes', 'Kowalski', 'Osei', 'Trahan',
];

const COUNTIES = [
  'austin', 'brazoria', 'brazos', 'burleson', 'chambers', 'fort_bend', 'galveston',
  'grimes', 'harris', 'liberty', 'madison', 'montgomery', 'robertson', 'san_jacinto',
  'trinity', 'walker', 'waller', 'washington',
];
const FOCUS = [
  'education', 'criminal_justice_reform', 'workforce_economic_development',
  'community_resources', 'basic_needs',
];
const FUNDING = ['programs', 'capacity_building', 'general_operating', 'capital_campaign'];

/**
 * Narrative fragments.
 *
 * Assembled rather than copied, so full-text search has genuinely different
 * documents to distinguish -- the motivating query in CLAUDE.md is "have we
 * ever funded youth mental health in Fort Bend County", and that only means
 * anything if the corpus contains things that are NOT youth mental health.
 */
const NEEDS = [
  'reading proficiency in our service area trails the state average by a wide margin',
  'more than a third of households here spend over half their income on rent',
  'the nearest mental health provider accepting our clients is a ninety-minute bus ride away',
  'returning citizens face a six-month gap between release and any stable income',
  'two of the three grocery stores serving this neighborhood closed in the last decade',
  'utility shutoffs in this ZIP code run at three times the county rate',
  'fewer than one in five students here has a family member who finished college',
  'the closest workforce training program stopped accepting new enrollments last year',
];
const APPROACHES = [
  'small-group tutoring four afternoons a week, run by trained neighborhood residents',
  'a paid apprenticeship placing participants with local employers for six months',
  'peer counseling delivered inside schools rather than asking families to travel',
  'a food pantry paired with benefits enrollment, so a visit resolves more than one need',
  'transitional housing with case management for the first twelve months',
  'a mobile clinic visiting four sites on a fixed weekly schedule',
  'financial coaching and a matched savings account for participating families',
  'a summer program keeping students engaged through the months they usually lose ground',
];
const POPULATIONS = [
  'students in grades 3 through 8, largely Black and Latino',
  'adults returning from incarceration within the past eighteen months',
  'families with children under five living below the federal poverty line',
  'high school students who would be the first in their family to attend college',
  'residents over 60 living alone on fixed incomes',
  'single-parent households in our immediate service area',
];

export interface DemoOrg {
  id: string;
  legalName: string;
  ein: string;
  email: string;
  firstName: string;
  lastName: string;
  city: string;
  mission: string;
  budgetCents: number;
}

/** Build N distinct invented organizations. */
export function buildOrganizations(count: number, rng: () => number): DemoOrg[] {
  const orgs: DemoOrg[] = [];
  const usedNames = new Set<string>();
  const usedEins = new Set<string>();

  while (orgs.length < count) {
    const legalName = `${pick(rng, PLACES)} ${pick(rng, THEMES)} ${pick(rng, SUFFIXES)}`;
    if (usedNames.has(legalName)) continue;
    usedNames.add(legalName);

    // EINs start 00, which the IRS does not issue -- an invented EIN should be
    // recognisably invented if it ever escapes a demo database.
    const ein = `00${String(int(rng, 1000000, 9999999))}`;
    if (usedEins.has(ein) || !normalizeEin(ein)) continue;
    usedEins.add(ein);

    const firstName = pick(rng, FIRST);
    const lastName = pick(rng, LAST);
    const slug = legalName.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
    orgs.push({
      id: newId(),
      legalName,
      ein,
      // example-*.org is reserved for documentation and cannot receive mail,
      // so a demo database cannot email a real person even by accident.
      email: `${firstName.toLowerCase()}@example-${slug}.org`,
      firstName,
      lastName,
      city: pick(rng, ['Houston', 'Pasadena', 'Baytown', 'Katy', 'Galveston', 'Conroe']),
      mission: `${pick(rng, APPROACHES).replace(/^a /, 'Providing ')}, for ${pick(rng, POPULATIONS)}.`,
      budgetCents: int(rng, 120, 4200) * 1000_00,
    });
  }
  return orgs;
}

export interface DemoApplication {
  organization: DemoOrg;
  status: 'submitted' | 'under_review' | 'awarded' | 'declined' | 'withdrawn';
  answers: Record<string, unknown>;
}

/**
 * Build one application's answers for the Inspire Change application form.
 *
 * Keys are field_keys, values are the RAW shapes an applicant would post, so
 * this data goes through exactly the same coercion and promotion as a real
 * submission rather than being written straight into columns.
 */
export function buildApplicationAnswers(org: DemoOrg, rng: () => number): Record<string, unknown> {
  const counties = Array.from(
    new Set(Array.from({ length: int(rng, 1, 4) }, () => pick(rng, COUNTIES))),
  );
  const need = pick(rng, NEEDS);
  const approach = pick(rng, APPROACHES);
  const population = pick(rng, POPULATIONS);
  const served = int(rng, 40, 2400);
  // Whole hundreds inside the published $10,000-$50,000 range.
  const amountDollars = int(rng, 100, 500) * 100;

  return {
    salutation: pick(rng, ['ms', 'mr', 'mx', 'dr']),
    contact_first_name: org.firstName,
    contact_last_name: org.lastName,
    contact_email: org.email,
    contact_phone: `713555${String(int(rng, 1000, 9999))}`,
    contact_job_title: pick(rng, [
      'Executive Director', 'Development Director', 'Program Manager', 'Founder',
    ]),
    organization_name: org.legalName,
    ein: org.ein,
    organization_website: `example-${org.legalName.toLowerCase().replace(/[^a-z]+/g, '')}.org`,
    organization_address: {
      address_1: `${int(rng, 100, 9800)} ${pick(rng, ['Main', 'Almeda', 'Airline', 'Telephone', 'Wayside'])} St`,
      city: org.city,
      state: 'TX',
      postal_code: `77${String(int(rng, 1, 99)).padStart(3, '0')}`,
    },
    mission_statement: org.mission,
    annual_operating_budget: `$${(org.budgetCents / 100).toLocaleString('en-US')}`,
    project_title: `${pick(rng, THEMES)} ${pick(rng, ['Lab', 'Bridge', 'Pathway', 'Corps', 'Studio', 'Table'])}`,
    requested_amount: `$${amountDollars.toLocaleString('en-US')}`,
    funding_type: pick(rng, FUNDING),
    area_of_focus: pick(rng, FOCUS),
    counties_served: counties,
    itemized_budget: `Staff time $${int(rng, 20, 60) * 1000}. Materials $${int(rng, 2, 9) * 1000}. Evaluation $${int(rng, 1, 5) * 1000}.`,
    advancing_opportunity: `We work where ${need}. Our approach is ${approach}.`,
    project_summary: `${approach.charAt(0).toUpperCase()}${approach.slice(1)}. Last year we served ${int(rng, 30, 900)} people and expect to reach ${served} with this grant.`,
    community_need: `In the neighborhoods we serve, ${need}. We are positioned to respond because our staff live here.`,
    implementation_timeline: 'Hire and train in the first quarter, launch in the second, evaluate each quarter thereafter.',
    individuals_benefiting: `Approximately ${served} people, primarily ${population}.`,
    estimated_individuals_count: String(served),
    leadership_lived_experience: 'Members of our leadership and board grew up in the communities this project serves.',
    partial_funding_plan: 'A smaller award would reduce the number of sites rather than the depth of service at each.',
    volunteer_engagement: pick(rng, [
      'Reading buddy sessions and a back-to-school supply drive.',
      'A volunteer build day and quarterly mentoring sessions.',
      '',
    ]),
    guidelines_attestation: true,
    marketing_opt_in: rng() > 0.5,
  };
}

/**
 * A realistic spread of outcomes.
 *
 * Weighted so that most applications are declined, which is what a 25-100
 * award programme against 100-400 applications actually looks like -- and it
 * is the shape that matters for the decision-communication work, where 250
 * declines go out in a week.
 */
export function pickStatus(rng: () => number): DemoApplication['status'] {
  const r = rng();
  if (r < 0.55) return 'declined';
  if (r < 0.75) return 'awarded';
  if (r < 0.9) return 'under_review';
  if (r < 0.97) return 'submitted';
  return 'withdrawn';
}

export interface DemoPlan {
  organizations: DemoOrg[];
  /** Two organizations deliberately share an EIN, to exercise the merge path. */
  duplicateOf: string | null;
  applications: DemoApplication[];
}

export function buildDemoPlan(
  opts: { organizations?: number; applications?: number; seed?: number } = {},
): DemoPlan {
  const rng = makeRng(opts.seed ?? 20260909);
  const orgCount = opts.organizations ?? 60;
  const appCount = opts.applications ?? 140;

  const organizations = buildOrganizations(orgCount, rng);

  // A deliberate duplicate: the same nonprofit entered twice, which CLAUDE.md
  // says is inevitable and which the merge tool exists for. A demo database
  // without one hides the problem the tool is meant to solve.
  const dupSource = organizations[3]!;
  const duplicate: DemoOrg = {
    ...dupSource,
    id: newId(),
    legalName: `${dupSource.legalName} Inc`,
    email: `info@example-dup-${dupSource.ein}.org`,
  };
  organizations.push(duplicate);

  const applications: DemoApplication[] = [];
  for (let i = 0; i < appCount; i++) {
    // Weighted towards repeat applicants: institutional memory is the point of
    // the history panel, and it shows nothing if every organization applies once.
    const org = organizations[int(rng, 0, organizations.length - 1)]!;
    applications.push({
      organization: org,
      status: pickStatus(rng),
      answers: buildApplicationAnswers(org, rng),
    });
  }

  return { organizations, duplicateOf: duplicate.id, applications };
}

export type { RequestContext };
