export type Layer = string;
export type Stage = 'logical' | 'physical';
export type Cardinality = 'many-to-one' | 'one-to-one' | 'one-to-many' | 'many-to-many';
export type ModelRole = 'conformed-dim' | 'domain-dim' | 'transaction-fact' | 'periodic-snapshot' | 'accumulating-snapshot' | 'factless-fact' | 'reference' | 'gold-fact' | 'gold-dim';

export interface ColumnDef {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  isNaturalKey?: boolean;
  scdType?: 0 | 1 | 2;
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
}

export interface Rationale {
  purpose?: string;
  design?: string;
  grainChoice?: string;
  roleChoice?: string;
  scdStrategy?: string;
  measures?: string;
}

export interface SemanticModel {
  name: string;
  schema?: string;
  description?: string;
  columns?: ColumnDef[];
  rationale?: Rationale;
  grain?: string;
  modelRole?: ModelRole;
}

export interface Relationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
}

export interface NodePosition { x: number; y: number; }
export type LayoutOptions = Record<string, string>;

export interface ViewConfig {
  showFkEdges?: boolean;
  layoutOptions?: LayoutOptions;
  positions?: Record<string, NodePosition>;
}

export interface ModelTemplate {
  id: string;
  label: string;
  prefix: string;
  description: string;
  columns: ColumnDef[];
}
