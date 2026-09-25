/**
 * The custom React Flow node and edge types the canvas renders. Module-level
 * constants, because React Flow expects `nodeTypes` / `edgeTypes` to keep the
 * same identity between renders.
 */

import type { NodeTypes, EdgeTypes } from '@xyflow/react';
import { ModelNode } from '../components/Graph/ModelNode';
import { FkEdge } from '../components/Graph/FkEdge';
import { AnnotationNode } from '../components/Graph/AnnotationNode';
import { AnnotationEdge } from '../components/Graph/AnnotationEdge';

/** Custom node types for React Flow — must be memoised or stable. */
export const canvasNodeTypes: NodeTypes = { model: ModelNode, annotation: AnnotationNode };

/** Custom edge types for React Flow — must be memoised or stable. */
export const canvasEdgeTypes: EdgeTypes = { fk: FkEdge, annotationLink: AnnotationEdge };
