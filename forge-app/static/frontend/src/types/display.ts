import type { Cardinality, Layer, ModelRole, Rationale, Stage, ViewConfig } from './semantic';
import type { LayerConfig } from './layer';

export interface DisplayColumn {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
  scdType?: 0 | 1 | 2;
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
}

export interface DisplayModel {
  name: string;
  schema: string;
  description: string;
  columns: DisplayColumn[];
  rationale?: Rationale;
  grain?: string;
  modelRole?: ModelRole;
  existsInManifest?: boolean;
}

export interface DisplayRelationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
}

export interface DisplayDomain {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  stage: Stage;
  description: string;
  modelFolder?: string;
  models: DisplayModel[];
  relationships: DisplayRelationship[];
  viewConfig: ViewConfig;
  layerConfig?: LayerConfig;
  readOnly: boolean;
  positionDraggable: boolean;
}
