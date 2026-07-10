export function formatDps(n: number): string {
  if (Number.isNaN(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}m`
}
