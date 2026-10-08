/**
 * Types for cross-stage discrepancy reports.
 *
 * A discrepancy report compares two stages of the same domain (e.g.,
 * physical vs logical) and highlights differences: extra/missing models,
 * extra/missing columns, data type mismatches, and cardinality differences.
 */

import type { Cardinality, Stage } from './semantic.js';
import type { ColumnPair } from '../relationships.js';

export interface DiscrepancyReport {
  domain: string;
  layer: string;
  /** The stage currently being viewed. */
  sourceStage: Stage;
  /** The stage being compared against. */
  targetStage: Stage;
  models: ModelDiscrepancy[];
  relationships: RelationshipDiscrepancy[];
  summary: {
    totalModels: number;
    matchedModels: number;
    extraModels: number;
    missingModels: number;
    totalColumns: number;
    matchedColumns: number;
    extraColumns: number;
    missingColumns: number;
    dataTypeMismatches: number;
    /** Columns where exactly one stage declares a data type. */
    undeclaredColumns: number;
  };
}

export interface ModelDiscrepancy {
  name: string;
  status: 'matched' | 'extra' | 'missing';
  columns: ColumnDiscrepancy[];
}

export interface ColumnDiscrepancy {
  name: string;
  /**
   * `undeclared` means exactly one stage declares a data type: nothing
   * conflicts, but one side has no type on record (a dbt yml with no
   * `data_type:`, say). It is kept out of `type-mismatch` so the summary is
   * not inflated, and still resolvable — `deriveColumnAction` gives it the
   * same update-type action.
   */
  status: 'matched' | 'extra' | 'missing' | 'type-mismatch' | 'undeclared';
  /** Data type in the source stage (the stage being viewed). */
  sourceDataType?: string;
  /** Data type in the target stage (the comparison stage). */
  targetDataType?: string;
}

export interface RelationshipDiscrepancy {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  status: 'matched' | 'extra' | 'missing' | 'cardinality-mismatch';
  sourceCardinality?: Cardinality;
  targetCardinality?: Cardinality;
  /**
   * A composite foreign key's column pairs, two or more (#133 L2): one entry
   * for the whole composite, whose `fromColumn` / `toColumn` are `pairs[0]`.
   */
  pairs?: ColumnPair[];
  /** The composite's name, from the stage that declares it. */
  compositeKey?: string;
  /**
   * Set only on an `extra` composite: the source draws a composite foreign
   * key the target does not declare as one. Informational — dbt can only
   * check it through a constraint or a dbt_constraints test.
   */
  composite?: true;
  /** On an `extra` composite: the pairs the target has no link for at all. */
  undeclaredPairs?: ColumnPair[];
}
