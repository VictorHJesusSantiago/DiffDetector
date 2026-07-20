import type { DriftFinding } from "./types.js";

export interface ScanDiffResult {
  added: DriftFinding[];
  removed: DriftFinding[];
  unchanged: DriftFinding[];
}

function key(f: Pick<DriftFinding, "type" | "subject">): string {
  return `${f.type}::${f.subject}`;
}

/** Compara dois conjuntos de achados (de scans distintos, não necessariamente consecutivos). */
export function diffFindings(before: DriftFinding[], after: DriftFinding[]): ScanDiffResult {
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));

  return {
    added: after.filter((f) => !beforeKeys.has(key(f))),
    removed: before.filter((f) => !afterKeys.has(key(f))),
    unchanged: after.filter((f) => beforeKeys.has(key(f))),
  };
}
