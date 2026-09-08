/**
 * The Phase 0 proof.
 *
 * A hypothetical second program, made DELIBERATELY DISSIMILAR to Inspire
 * Change, used by the test suite to verify the claim that adding a program
 * requires zero schema changes.
 *
 * Ways it differs on purpose:
 *   - TWO stages (letter of intent, then an invited full application) where
 *     Inspire Change has one
 *   - the second stage is GATED on a decision at the first
 *   - different sections, different field keys, different labels
 *   - different option sets (statewide regions, not Houston-area counties)
 *   - a field type combination Inspire Change does not use (integer with a
 *     range, a URL field that is required, a nested conditional two levels deep)
 *   - a rolling cycle with a non-zero draft grace window
 *
 * If this seeds and renders without a migration, the form engine is generic.
 * If it does not, Phase 0 has failed and the test will say so.
 */

import type { ProgramSpec } from './types';

const TEXAS_REGIONS = [
  { value: 'gulf_coast', label: 'Gulf Coast' },
  { value: 'north_texas', label: 'North Texas' },
  { value: 'central_texas', label: 'Central Texas' },
  { value: 'south_texas', label: 'South Texas' },
  { value: 'west_texas', label: 'West Texas' },
  { value: 'panhandle', label: 'Panhandle' },
  { value: 'east_texas', label: 'East Texas' },
];

export const SECOND_PROGRAM: ProgramSpec = {
  slug: 'community-futures-fund',
  name: 'Community Futures Fund',
  description:
    'A two-stage fund: a short letter of intent, then a full application by invitation only.',
  fiscalYear: 2026,
  totalBudgetCents: 45_000_000, // $450,000.00
  compliancePolicy: 'block', // differs from Inspire Change on purpose
  guidelinesVersion: 'cff-2026-a',

  stages: [
    // ---- Stage 1: letter of intent -------------------------------------------
    {
      key: 'loi',
      name: 'Letter of intent',
      form: {
        name: 'Community Futures Fund - Letter of Intent',
        sections: [
          {
            key: 'about',
            title: 'About your organization',
            description: 'Five minutes. We invite full applications from here.',
            fields: [
              {
                key: 'org_legal_name',
                label: 'Legal name of organization',
                type: 'short_text',
                required: true,
                mapsTo: 'organization_name',
              },
              {
                key: 'tax_id',
                label: 'Federal tax identification number',
                type: 'short_text',
                required: true,
                mapsTo: 'ein',
              },
              {
                key: 'lead_contact_email',
                label: 'Contact email',
                type: 'email',
                required: true,
                mapsTo: 'primary_contact_email',
              },
              {
                key: 'years_operating',
                label: 'Years your organization has been operating',
                type: 'integer',
                required: true,
                validation: { min: 0, max: 200 },
              },
              {
                key: 'org_website',
                label: 'Website',
                type: 'url',
                required: true, // required here, optional in Inspire Change
                mapsTo: 'organization_website',
              },
            ],
          },
          {
            key: 'concept',
            title: 'Your concept',
            fields: [
              {
                key: 'amount_sought',
                label: 'Amount you intend to request',
                type: 'currency',
                required: true,
                mapsTo: 'requested_amount_cents',
                validation: { min_cents: 1_000_000, max_cents: 7_500_000 },
              },
              {
                key: 'regions_served',
                label: 'Regions of Texas served',
                type: 'multi_select',
                required: true,
                mapsTo: 'counties_served',
                options: TEXAS_REGIONS,
                validation: { min: 1, max: 3 },
              },
              {
                key: 'concept_summary',
                label: 'Describe your concept in 200 words or fewer.',
                type: 'long_text',
                required: true,
                validation: { max_words: 200 },
              },
              {
                key: 'prior_funding',
                label: 'Have you received funding from this fund before?',
                type: 'select',
                required: true,
                options: [
                  { value: 'no', label: 'No' },
                  { value: 'yes', label: 'Yes' },
                ],
              },
              {
                key: 'prior_funding_year',
                label: 'Most recent year funded',
                type: 'integer',
                required: true,
                conditionalOn: { fieldKey: 'prior_funding', value: 'yes' },
                validation: { min: 1990, max: 2100 },
              },
              {
                key: 'prior_funding_outcome',
                label: 'Briefly, what did that funding achieve?',
                type: 'long_text',
                // A SECOND-LEVEL conditional: only shown when the year field is
                // itself visible. Inspire Change has nothing like this.
                conditionalOn: { fieldKey: 'prior_funding', value: 'yes' },
                validation: { max_words: 150 },
              },
            ],
          },
        ],
      },
    },

    // ---- Stage 2: invited full application -----------------------------------
    {
      key: 'full',
      name: 'Full application',
      gateOnPriorDecision: true, // cannot start until the LOI has a decision
      form: {
        name: 'Community Futures Fund - Full Application',
        sections: [
          {
            key: 'confirm',
            title: 'Confirm your details',
            fields: [
              {
                key: 'org_legal_name',
                label: 'Legal name of organization',
                type: 'short_text',
                required: true,
                mapsTo: 'organization_name',
              },
              {
                key: 'tax_id',
                label: 'Federal tax identification number',
                type: 'short_text',
                required: true,
                mapsTo: 'ein',
              },
              {
                key: 'lead_contact_email',
                label: 'Contact email',
                type: 'email',
                required: true,
                mapsTo: 'primary_contact_email',
              },
              {
                key: 'mailing_address',
                label: 'Mailing address',
                type: 'address_block',
                required: true,
                // Different required parts than Inspire Change.
                validation: { required_parts: ['address_1', 'city', 'state', 'postal_code', 'country'] },
              },
            ],
          },
          {
            key: 'proposal',
            title: 'Proposal',
            fields: [
              {
                key: 'final_amount',
                label: 'Final amount requested',
                type: 'currency',
                required: true,
                mapsTo: 'requested_amount_cents',
                validation: { min_cents: 1_000_000, max_cents: 7_500_000 },
              },
              {
                key: 'regions_served',
                label: 'Regions of Texas served',
                type: 'multi_select',
                required: true,
                mapsTo: 'counties_served',
                options: TEXAS_REGIONS,
              },
              {
                key: 'full_narrative',
                label: 'Full proposal narrative',
                type: 'long_text',
                required: true,
                validation: { min_words: 200, max_words: 1200 },
              },
              {
                key: 'evaluation_plan',
                label: 'How will you evaluate success?',
                type: 'long_text',
                required: true,
                validation: { max_words: 400 },
              },
              {
                key: 'budget_document',
                label: 'Detailed project budget',
                type: 'file_upload',
                required: true,
                validation: { max_files: 1, max_size_bytes: 5 * 1024 * 1024 },
              },
              {
                key: 'board_list',
                label: 'Current board roster',
                type: 'file_upload',
                required: true,
                validation: { max_files: 1 },
              },
            ],
          },
          {
            key: 'attest',
            title: 'Attestation',
            fields: [
              {
                key: 'accuracy_attestation',
                label: 'Everything in this application is accurate to the best of my knowledge.',
                type: 'checkbox_attestation',
                required: true,
              },
            ],
          },
        ],
      },
    },
  ],

  cycles: [
    {
      name: 'FY2026 Rolling',
      opensAt: '2026-02-01T14:00:00.000Z',
      closesAt: '2026-11-30T05:59:59.000Z',
      status: 'draft',
      // A grace window, where Inspire Change has a hard cutoff.
      draftGraceHours: 24,
    },
  ],
};
