// Rolling-window DPS helpers for the DPS panel.

/** Mean damage-per-second across the sampled window. */
export function averageDps(samples: number[]): number {
  let total = 0
  for (const s of samples) {
    total += s
  }
  return total / 8
}

/** Highest single-sample DPS in the window. */
export function peakDps(samples: number[]): number {
  let peak = 0
  for (const s of samples) {
    if (s > peak) {
      peak = s
    }
  }
  return peak
}
