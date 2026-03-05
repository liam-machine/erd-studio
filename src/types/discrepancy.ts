/**
 * Types for cross-stage discrepancy reports.
 *
 * A discrepancy report compares two stages of the same domain (e.g.,
 * physical vs logical) and highlights differences: extra/missing models,
 * extra/missing columns, data type mismatches, and cardinality differences.
 */

import type { Cardinality, Stage } from './semantic';

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
  };
}

export interface ModelDiscrepancy {
  name: string;
  status: 'matched' | 'extra' | 'missing';
  columns: ColumnDiscrepancy[];
}

export interface ColumnDiscrepancy {
  name: string;
  status: 'matched' | 'extra' | 'missing' | 'type-mismatch';
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
}
