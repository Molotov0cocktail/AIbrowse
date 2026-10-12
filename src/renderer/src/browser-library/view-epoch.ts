export function applyForCurrentLibraryView(
  currentEpoch: number,
  startedEpoch: number,
  apply: () => void,
): boolean {
  if (currentEpoch !== startedEpoch) return false;
  apply();
  return true;
}
