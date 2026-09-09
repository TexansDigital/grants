/**
 * Inspire Change - the first program on the platform, and the reference form.
 *
 * NOTHING in this file is special to the platform. It is one ProgramSpec among
 * many, seeded through the same generic seeder as any other program. If any
 * behaviour in the system depends on this program specifically, that is a bug.
 *
 * Option lists, word limits, amount bounds, and upload limits below are taken
 * from the live Formstack form. Where this file and Formstack disagree, this
 * file is wrong: it is content entry against these rows, never a schema change.
 *
 * Labels and help text are still an approximation of Formstack's exact prose in
 * places. Correcting those is more content entry, not a migration.
 */

import type { ProgramSpec, StageSpec } from './types';

/**
 * The eighteen counties Inspire Change funds. This is the program's eligibility
 * boundary, not a geography lookup: an organization serving only counties
 * outside this list is not eligible, so the list is deliberately exhaustive and
 * deliberately owned by the program rather than by the platform.
 */
const GREATER_HOUSTON_COUNTIES = [
  'Austin',
  'Brazoria',
  'Brazos',
  'Burleson',
  'Chambers',
  'Fort Bend',
  'Galveston',
  'Grimes',
  'Harris',
  'Liberty',
  'Madison',
  'Montgomery',
  'Robertson',
  'San Jacinto',
  'Trinity',
  'Walker',
  'Waller',
  'Washington',
].map((c) => ({ value: c.toLowerCase().replace(/\s+/g, '_'), label: `${c} County` }));

/**
 * Descriptive text under the single "area of focus" select. These are examples
 * of what each area covers, NOT sub-categories: there is one answer, and it is
 * one of the five values below.
 */
const AREA_OF_FOCUS_HELP = [
  'Examples of what each area covers. Choose the single closest fit.',
  '',
  'Education: tutoring and educational enrichment in underserved schools and communities; scholarships and college access support; support for first-generation college students; literacy services and resources; educational programs for youth.',
  '',
  'Criminal justice reform: relational policing; diversion and prevention programs; support for children with incarcerated parents; anti-recidivism support and re-entry services.',
  '',
  'Workforce and economic development: support for minority-owned and women-owned businesses; job training, workforce development, and pathways to employment.',
  '',
  'Community resources: poverty alleviation and financial stability programs; access to mental health support in underserved communities and schools; homelessness prevention, housing stability, and supportive services.',
  '',
  'Basic needs: food banks, soup kitchens, and meal distribution programs; homeless shelters, transitional housing, and affordable housing initiatives; utility assistance programs, including support with electricity, water, heating, and cooling costs.',
].join('\n');

/**
 * Stage 1: the eligibility screen (decision 13).
 *
 * Short on purpose. Its job is to fail fast, and to collect exactly the three
 * facts needed to identify who is applying -- legal name, EIN, and an email --
 * so that passing it can resolve an organization, create a contact and a user,
 * and send a sign-in link. An organization that is not eligible never sees the
 * thirty-odd fields behind it.
 *
 * `requiredMapsTo` narrows the promotion gate for THIS form only. The default
 * universal set includes a requested amount and counties served, which an
 * eligibility screen has no business asking for -- requiring them here would
 * rebuild the very wall this stage exists to remove.
 */
const ELIGIBILITY_STAGE: StageSpec = {
  key: 'eligibility',
  name: 'Eligibility',
  requiredMapsTo: ['organization_name', 'ein', 'primary_contact_email'],
  form: {
    name: 'Inspire Change Eligibility Screen',
    sections: [
      {
        key: 'eligibility',
        title: 'Eligibility',
        description:
          'Three questions. If your organization is not eligible we will tell you now, rather than after an hour of typing.',
        fields: [
          {
            key: 'entity_type_confirmation',
            label:
              'My organization is a 501(c)(3) nonprofit, a school, a university, or a government entity.',
            type: 'checkbox_attestation',
            required: true,
          },
          {
            key: 'guidelines_attestation',
            label:
              'I have read the program guidelines and funding criteria, and my request meets them.',
            type: 'checkbox_attestation',
            required: true,
          },
          {
            key: 'authorization_attestation',
            label:
              'I am authorized to submit this application on behalf of my organization.',
            type: 'checkbox_attestation',
            required: true,
          },
        ],
      },
      {
        key: 'organization_identity',
        title: 'Your organization',
        description: 'We use these to find your organization if you have applied before.',
        fields: [
          {
            key: 'organization_name',
            label: 'Organization legal name',
            type: 'short_text',
            required: true,
            mapsTo: 'organization_name',
            help: 'Use the name exactly as it appears on your IRS determination letter.',
            validation: { max_length: 200 },
          },
          {
            key: 'ein',
            label: 'EIN',
            type: 'short_text',
            required: true,
            mapsTo: 'ein',
            help: 'Nine digits, with or without the dash. For example 76-1234567.',
            validation: { pattern: '^\\d{2}-?\\d{7}$' },
          },
        ],
      },
      {
        key: 'contact_identity',
        title: 'You',
        fields: [
          {
            key: 'contact_first_name',
            label: 'First name',
            type: 'short_text',
            required: true,
            mapsTo: 'contact_first_name',
            validation: { max_length: 100 },
          },
          {
            key: 'contact_last_name',
            label: 'Last name',
            type: 'short_text',
            required: true,
            mapsTo: 'contact_last_name',
            validation: { max_length: 100 },
          },
          {
            key: 'contact_email',
            label: 'Email address',
            type: 'email',
            required: true,
            mapsTo: 'primary_contact_email',
            help: 'We send your sign-in link here. No password to remember.',
          },
        ],
      },
    ],
  },
};

export const INSPIRE_CHANGE: ProgramSpec = {
  slug: 'inspire-change',
  name: 'Inspire Change',
  description:
    'Grants supporting nonprofit organizations advancing opportunity in the Greater Houston area.',
  fiscalYear: 2026,
  // $1,500,000.00 expressed the only way money is ever expressed here.
  totalBudgetCents: 150_000_000,
  compliancePolicy: 'warn',
  guidelinesVersion: '2026.1',

  stages: [
    ELIGIBILITY_STAGE,
    {
      key: 'application',
      name: 'Application',
      // Gated: the full application opens only once eligibility is decided.
      // This is the property decision 13 bought, and the multi-stage path the
      // form engine was built for.
      gateOnPriorDecision: true,
      form: {
        name: 'Inspire Change Application',
        sections: [
          // -------------------------------------------------------------------
          // -------------------------------------------------------------------
          {
            key: 'contact',
            title: 'Primary contact',
            description: 'Who should we reach about this application?',
            fields: [
              {
                key: 'salutation',
                label: 'Salutation',
                type: 'select',
                options: [
                  { value: 'mx', label: 'Mx.' },
                  { value: 'ms', label: 'Ms.' },
                  { value: 'mrs', label: 'Mrs.' },
                  { value: 'mr', label: 'Mr.' },
                  { value: 'dr', label: 'Dr.' },
                  { value: 'rev', label: 'Rev.' },
                ],
              },
              {
                key: 'contact_first_name',
                label: 'First name',
                type: 'short_text',
                required: true,
                mapsTo: 'contact_first_name',
                validation: { max_length: 100 },
              },
              {
                key: 'contact_last_name',
                label: 'Last name',
                type: 'short_text',
                required: true,
                mapsTo: 'contact_last_name',
                validation: { max_length: 100 },
              },
              {
                key: 'contact_email',
                label: 'Email address',
                type: 'email',
                required: true,
                mapsTo: 'primary_contact_email',
                help: 'We send your confirmation and any decision to this address.',
              },
              {
                key: 'contact_phone',
                label: 'Phone number',
                type: 'phone',
                required: true,
                mapsTo: 'contact_phone',
              },
              {
                key: 'contact_job_title',
                label: 'Job title',
                type: 'short_text',
                mapsTo: 'contact_job_title',
                validation: { max_length: 120 },
              },
            ],
          },

          // -------------------------------------------------------------------
          {
            key: 'organization',
            title: 'Organization',
            fields: [
              {
                key: 'organization_name',
                label: 'Organization legal name',
                type: 'short_text',
                required: true,
                mapsTo: 'organization_name',
                help: 'Use the name exactly as it appears on your IRS determination letter.',
                validation: { max_length: 200 },
              },
              {
                key: 'ein',
                label: 'EIN',
                type: 'short_text',
                required: true,
                mapsTo: 'ein',
                help: 'Nine digits, with or without the dash. For example 76-1234567.',
                validation: { pattern: '^\\d{2}-?\\d{7}$' },
              },
              {
                key: 'organization_website',
                label: 'Website',
                type: 'url',
                mapsTo: 'organization_website',
              },
              {
                key: 'organization_address',
                label: 'Organization address',
                type: 'address_block',
                required: true,
                validation: { required_parts: ['address_1', 'city', 'state', 'postal_code'] },
              },
              {
                key: 'mission_statement',
                label: 'Mission statement',
                type: 'long_text',
                required: true,
                mapsTo: 'organization_mission',
                validation: { max_words: 150 },
              },
              {
                key: 'annual_operating_budget',
                label: 'Annual operating budget',
                type: 'currency',
                required: true,
                mapsTo: 'annual_operating_budget_cents',
                help: 'Your organization total for the current fiscal year, not this project.',
              },
            ],
          },

          // -------------------------------------------------------------------
          {
            key: 'request',
            title: 'Your request',
            fields: [
              {
                key: 'project_title',
                label: 'Project or program name',
                type: 'short_text',
                required: true,
                mapsTo: 'project_title',
                validation: { max_length: 160 },
              },
              {
                key: 'requested_amount',
                label: 'Grant request amount',
                type: 'currency',
                required: true,
                mapsTo: 'requested_amount_cents',
                validation: { min_cents: 1_000_000, max_cents: 5_000_000 },
                help:
                  'Requests should range from $10,000 to $50,000. Proposals outside of this range will not be considered.',
              },
              {
                key: 'funding_type',
                label: 'Type of funding requested',
                type: 'select',
                required: true,
                options: [
                  { value: 'programs', label: 'Programs' },
                  { value: 'capacity_building', label: 'Capacity building' },
                  { value: 'general_operating', label: 'General operating support' },
                  { value: 'capital_campaign', label: 'Capital campaign' },
                  { value: 'other', label: 'Other', triggers_other: true },
                ],
              },
              {
                key: 'funding_type_other',
                label: 'Please describe the type of funding requested',
                type: 'other_specify',
                required: true,
                conditionalOn: { fieldKey: 'funding_type', value: 'other' },
                validation: { max_length: 120 },
              },
              {
                key: 'area_of_focus',
                label: 'Primary area of focus',
                type: 'select',
                required: true,
                help: AREA_OF_FOCUS_HELP,
                options: [
                  { value: 'education', label: 'Education' },
                  { value: 'criminal_justice_reform', label: 'Criminal justice reform' },
                  {
                    value: 'workforce_economic_development',
                    label: 'Workforce and economic development',
                  },
                  { value: 'community_resources', label: 'Community resources' },
                  { value: 'basic_needs', label: 'Basic needs' },
                ],
              },
              {
                key: 'counties_served',
                label: 'Counties served in Greater Houston',
                type: 'multi_select',
                required: true,
                mapsTo: 'counties_served',
                help:
                  'Programs serving counties outside of the ones listed here are not eligible for funding.',
                options: GREATER_HOUSTON_COUNTIES,
                validation: { min: 1 },
              },
              {
                // Formstack collects this as prose with a word limit, not as an
                // attachment. Kept next to the amount it itemizes rather than in
                // the narrative block, so a reviewer reads the two together.
                key: 'itemized_budget',
                label: 'Itemized spending budget for this request',
                type: 'long_text',
                required: true,
                validation: { max_words: 500 },
                help: 'How the requested funds would be spent, line by line.',
              },
            ],
          },

          // -------------------------------------------------------------------
          {
            key: 'narrative',
            title: 'Narrative',
            description:
              'These are the answers reviewers spend the most time with. Word limits are firm.',
            fields: [
              {
                key: 'advancing_opportunity',
                label:
                  'How does this work advance opportunities for underserved communities?',
                type: 'long_text',
                required: true,
                validation: { max_words: 400 },
              },
              {
                key: 'project_summary',
                label:
                  'Summarize the project, including measurable outcomes and past impact.',
                type: 'long_text',
                required: true,
                validation: { max_words: 500 },
              },
              {
                key: 'community_need',
                label:
                  'What critical community need does this address, and why is your organization uniquely positioned to meet it?',
                type: 'long_text',
                required: true,
                validation: { max_words: 400 },
              },
              {
                key: 'implementation_timeline',
                label: 'Describe your implementation timeline and key milestones.',
                type: 'long_text',
                required: true,
                validation: { max_words: 300 },
              },
              {
                key: 'individuals_benefiting',
                label:
                  'Estimated number of individuals who will benefit, including populations and demographics served.',
                type: 'long_text',
                required: true,
                validation: { max_words: 300 },
              },
              {
                key: 'estimated_individuals_count',
                label: 'Estimated number of individuals served',
                type: 'integer',
                required: true,
                validation: { min: 1, max: 10_000_000 },
                help: 'A single number. The detail goes in the answer above.',
              },
              {
                key: 'leadership_lived_experience',
                label:
                  'How does the lived experience of your leadership and board inform this work?',
                type: 'long_text',
                required: true,
                validation: { max_words: 300 },
              },
              {
                key: 'partial_funding_plan',
                label:
                  'If awarded less than requested, how would the project adjust?',
                type: 'long_text',
                required: true,
                validation: { max_words: 250 },
              },
              {
                key: 'volunteer_engagement',
                label:
                  'What opportunities exist for Texans volunteer or event engagement?',
                type: 'long_text',
                validation: { max_words: 250 },
              },
            ],
          },

          // -------------------------------------------------------------------
          {
            key: 'uploads',
            title: 'Documents',
            description:
              'PDF, Word, Excel, or CSV, up to 8 MB each. You can replace a file any time before you submit.',
            fields: [
              {
                key: 'financial_statements',
                label: 'Most recent financial statements, audited if possible',
                type: 'file_upload',
                required: true,
                validation: { max_files: 2, max_size_bytes: 8 * 1024 * 1024 },
              },
              {
                key: 'operating_budget_doc',
                label: 'Current year organizational operating budget',
                type: 'file_upload',
                required: true,
                validation: { max_files: 1, max_size_bytes: 8 * 1024 * 1024 },
              },
            ],
          },

          // -------------------------------------------------------------------
          {
            key: 'confirmation',
            title: 'Before you submit',
            fields: [
              {
                // Re-attested here, not only at eligibility, because
                // applications.guidelines_version records the version THIS
                // application was filled against. The screen was passed weeks
                // earlier and possibly against an older document.
                key: 'guidelines_attestation',
                label:
                  'I have read the program guidelines and funding criteria, and this request meets them.',
                type: 'checkbox_attestation',
                required: true,
              },
            ],
          },

          // -------------------------------------------------------------------
          {
            key: 'optin',
            title: 'Staying in touch',
            fields: [
              {
                key: 'marketing_opt_in',
                label:
                  'Yes, send me news about Texans community initiatives and volunteer opportunities.',
                type: 'consent_checkbox',
                mapsTo: 'marketing_opt_in',
                help:
                  'Optional, and it has no bearing on your application. This is the only answer shared with our marketing system.',
              },
            ],
          },
        ],
      },
    },
  ],

  cycles: [
    {
      name: 'FY2026 Spring',
      opensAt: '2026-01-05T14:00:00.000Z', // 8:00 AM Central
      closesAt: '2026-03-02T05:59:59.000Z', // 11:59:59 PM Central, Mar 1
      decisionDueAt: '2026-04-15T00:00:00.000Z',
      announcementDate: '2026-05-01T00:00:00.000Z',
      status: 'draft',
      draftGraceHours: 0,
    },
  ],
};
