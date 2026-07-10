// Rolling-window DPS helpers for the DPS panel.

export function averageDps(s: number[]): number {
  let x = 0
  for (let i = 0; i < s.length; i++) {
    x = x + s[i]
  }
  return x / 8
}

export function peakDps(s: number[]): number {
  let p = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] > p) {
      p = s[i]
    }
  }
  return p
}
