export const STAGE_HEX: Record<string, string> = {
  logical: '#60a5fa',
  physical: '#22c55e',
  ghost: '#9ca3af',
};

export function stageNodeColor(stage: string, isGhost?: boolean): string {
  if (isGhost) return STAGE_HEX.ghost;
  return STAGE_HEX[stage] ?? STAGE_HEX.ghost;
}
