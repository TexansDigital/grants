/**
 * Declarative program specification used by the seeder.
 *
 * This shape is deliberately close to what a future admin UI will POST. A
 * program is described entirely as DATA - stages, sections, fields, options,
 * validation, conditional logic, and maps_to targets. Nothing here implies a
 * migration, and that is the property Phase 0 exists to prove.
 */

import type { FieldOption, FieldType, FieldValidation } from '../lib/fieldTypes';
import type { MapsToTarget } from '../lib/mapsTo';

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  options?: FieldOption[];
  validation?: FieldValidation;
  mapsTo?: MapsToTarget;
  /** Reveal this field only when another field holds a given value. */
  conditionalOn?: { fieldKey: string; value: string };
}

export interface SectionSpec {
  key: string;
  title: string;
  description?: string;
  fields: FieldSpec[];
}

export interface StageSpec {
  key: string;
  name: string;
  /** Applicant may not begin this stage until the prior stage has a decision. */
  gateOnPriorDecision?: boolean;
  form: {
    name: string;
    sections: SectionSpec[];
  };
}

export interface CycleSpec {
  name: string;
  opensAt: string;
  closesAt: string;
  decisionDueAt?: string;
  announcementDate?: string;
  status?: 'draft' | 'open' | 'closed' | 'decided' | 'archived';
  /** Grace window for drafts started before close. 0 = hard cutoff. */
  draftGraceHours?: number;
}

export interface ProgramSpec {
  slug: string;
  name: string;
  description: string;
  fiscalYear: number;
  totalBudgetCents: number;
  compliancePolicy: 'block' | 'warn' | 'ignore';
  guidelinesVersion: string;
  stages: StageSpec[];
  cycles: CycleSpec[];
}
