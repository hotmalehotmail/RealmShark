// Small DPS helper. Throwaway file used to exercise CI + the review agent;
// safe to delete.
export function averageDps(samples: number[]): number {
  let total = 0
  for (const s of samples) {
    total += s
  }
  return total / 8
}
