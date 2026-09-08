/**
 * Inspire Change - the first program on the platform, and the reference form.
 *
 * NOTHING in this file is special to the platform. It is one ProgramSpec among
 * many, seeded through the same generic seeder as any other program. If any
 * behaviour in the system depends on this program specifically, that is a bug.
 *
 * SCOPE NOTE (flagged at build time): this is a STRUCTURALLY complete form
 * covering every field in the reference list, with every field type exercised.
 * It is NOT copy-faithful to the current Formstack form - exact labels, help
 * text, and option wording still need to come from the Formstack export. That
 * is content entry against these rows, not a schema change.
 */

import type { ProgramSpec } from './types';

/** The Houston-The Woodlands-Sugar Land MSA, plus two counties commonly served. */
const GREATER_HOUSTON_COUNTIES = [
  'Austin',
  'Brazoria',
  'Chambers',
  'Fort Bend',
  'Galveston',
  'Harris',
  'Liberty',
  'Montgomery',
  'San Jacinto',
  'Waller',
  'Walker',
].map((c) => ({ value: c.toLowerCase().replace(/\s+/g, '_'), label: `${c} County` }));

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
    {
      key: 'application',
      name: 'Application',
      form: {
        name: 'Inspire Change Application',
        sections: [
          // -------------------------------------------------------------------
          {
            key: 'eligibility',
            title: 'Eligibility and attestations',
            description:
              'Confirm your organization is eligible before you begin. These take about a minute.',
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
                validation: { min_cents: 500_000, max_cents: 10_000_000 },
                help: 'Requests are typically between $5,000 and $100,000.',
              },
              {
                key: 'funding_type',
                label: 'Type of funding requested',
                type: 'select',
                required: true,
                options: [
                  { value: 'program', label: 'Program or project support' },
                  { value: 'general_operating', label: 'General operating support' },
                  { value: 'capital', label: 'Capital' },
                  { value: 'capacity_building', label: 'Capacity building' },
                ],
              },
              {
                key: 'area_of_focus',
                label: 'Primary area of focus',
                type: 'select',
                required: true,
                options: [
                  { value: 'education', label: 'Education' },
                  { value: 'economic_opportunity', label: 'Economic opportunity' },
                  { value: 'health_wellness', label: 'Health and wellness' },
                  { value: 'youth_development', label: 'Youth development' },
                  { value: 'criminal_justice', label: 'Criminal justice reform' },
                  { value: 'police_community', label: 'Police and community relations' },
                  { value: 'other', label: 'Other', triggers_other: true },
                ],
              },
              {
                key: 'area_of_focus_other',
                label: 'Please specify your area of focus',
                type: 'other_specify',
                required: true,
                conditionalOn: { fieldKey: 'area_of_focus', value: 'other' },
                validation: { max_length: 120 },
              },
              {
                key: 'counties_served',
                label: 'Counties served in Greater Houston',
                type: 'multi_select',
                required: true,
                mapsTo: 'counties_served',
                options: GREATER_HOUSTON_COUNTIES,
                validation: { min: 1 },
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
              'PDF, Word, Excel, or CSV, up to 15 MB each. You can replace a file any time before you submit.',
            fields: [
              {
                key: 'itemized_budget',
                label: 'Itemized spending budget for this request',
                type: 'file_upload',
                required: true,
                validation: { max_files: 1 },
              },
              {
                key: 'financial_statements',
                label: 'Most recent financial statements, audited if available',
                type: 'file_upload',
                required: true,
                validation: { max_files: 2 },
              },
              {
                key: 'operating_budget_doc',
                label: 'Current year organizational operating budget',
                type: 'file_upload',
                required: true,
                validation: { max_files: 1 },
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
