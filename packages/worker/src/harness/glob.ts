const windows = process.platform === 'win32'
export const manifestKey = (path: string) => windows ? path.toLowerCase() : path

function expression(pattern: string, braces: boolean): string {
  let regex = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*' && (i === 0 || pattern[i - 1] === '/') && pattern[i + 1] === '*' &&
        (i + 2 === pattern.length || pattern[i + 2] === '/')) {
      if (i + 2 === pattern.length) { regex += '.*'; i++ }
      else { regex += '(?:[^/]+/)*'; i += 2 }
    } else if (char === '*') regex += '[^/]*'
    else if (char === '?') regex += '[^/]'
    else if (char === '{' && braces && pattern.indexOf('}', i) > i) {
      const end = pattern.indexOf('}', i)
      regex += '(?:' + pattern.slice(i + 1, end).split(',').map(s => expression(s, false)).join('|') + ')'
      i = end
    } else regex += char.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')
  }
  return regex
}
export function compileGlob(pattern: string, insensitive = windows) {
  return new RegExp('^(?:' + expression(pattern, true) + ')$', insensitive ? 'isu' : 'su')
}
