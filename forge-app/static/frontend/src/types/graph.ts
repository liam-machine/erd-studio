import type { Node, Edge } from '@xyflow/react';
import type { Cardinality, Layer, ModelRole, Stage } from './semantic';
import type { LayerConfig } from './layer';

export interface ColumnDisplay {
  name: string;
  dataType: string;
  description?: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
  scdType?: 0 | 1 | 2;
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
}

export type ModelNodeData = {
  modelName: string;
  stage: Stage;
  layer: Layer;
  layerConfig?: LayerConfig;
  columns: ColumnDisplay[];
  dimmed?: boolean;
  isExpanded?: boolean;
  onToggleExpansion?: (modelName: string) => void;
  hasRationale?: boolean;
  grain?: string;
  modelRole?: ModelRole;
  readOnly?: boolean;
  isGhost?: boolean;
  [key: string]: unknown;
};

export type ModelFlowNode = Node<ModelNodeData, 'model'>;

export type FkEdgeData = {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
  stage?: Stage;
  dimmed?: boolean;
  readOnly?: boolean;
  [key: string]: unknown;
};

export type FkFlowEdge = Edge<FkEdgeData, 'fk'>;
