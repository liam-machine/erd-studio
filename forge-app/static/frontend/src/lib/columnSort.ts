interface KeyFlags {
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
}

function getKeyPriority(col: KeyFlags): number {
  if (col.isPrimaryKey) return 0;
  if (col.isNaturalKey) return 1;
  if (col.isForeignKey) return 2;
  return 3;
}

export function sortColumnsByKeyPriority<T extends KeyFlags>(columns: T[]): T[] {
  return columns.slice().sort((a, b) => getKeyPriority(a) - getKeyPriority(b));
}
