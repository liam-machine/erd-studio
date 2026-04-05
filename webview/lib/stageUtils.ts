/** Human-readable label for a stage identifier. */
export function stageName(stage: string): string {
  switch (stage) {
    case 'logical': return 'Logical';
    case 'physical': return 'Physical';
    default: return stage;
  }
}
