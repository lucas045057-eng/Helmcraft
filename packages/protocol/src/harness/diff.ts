type Line = { op: ' ' | '+' | '-'; text: string }

// Hirschberg's LCS reconstruction keeps memory linear for newline-heavy snapshots.
function lengths(a: string[], b: string[]): Uint16Array {
  const row = new Uint16Array(b.length + 1)
  for (const line of a) {
    let previous = 0
    for (let j = 0; j < b.length; j++) {
      const old = row[j + 1]!
      row[j + 1] = line === b[j] ? previous + 1 : Math.max(row[j]!, old)
      previous = old
    }
  }
  return row
}
function align(a: string[], b: string[], out: Line[]): void {
  let first = 0
  while (first < a.length && first < b.length && a[first] === b[first]) {
    out.push({ op: ' ', text: a[first++]! })
  }
  a = a.slice(first)
  b = b.slice(first)
  if (!a.length || !b.length) {
    for (const text of a) out.push({ op: '-', text })
    for (const text of b) out.push({ op: '+', text })
  } else if (a.length === 1) {
    const index = b.indexOf(a[0]!)
    if (index < 0) out.push({ op: '-', text: a[0]! })
    b.forEach((text, i) => out.push({ op: i === index ? ' ' : '+', text }))
  } else {
    const mid = Math.floor(a.length / 2)
    const left = lengths(a.slice(0, mid), b)
    const right = lengths(a.slice(mid).reverse(), [...b].reverse())
    let split = 0
    for (let i = 1; i <= b.length; i++) {
      if (left[i]! + right[b.length - i]! > left[split]! + right[b.length - split]!) split = i
    }
    align(a.slice(0, mid), b.slice(0, split), out)
    align(a.slice(mid), b.slice(split), out)
  }
}
export function diffLines(a: string, b: string): Line[] {
  const split = (text: string) => text ? text.replace(/\r?\n$/u, '').split(/\r?\n/u) : []
  const result: Line[] = []
  align(split(a), split(b), result)
  return result
}
