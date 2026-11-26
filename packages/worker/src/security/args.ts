export function filterExtraArgs(args: readonly string[], allowed: readonly string[], warn?: (count: number) => void) {
  const filtered = args.filter(arg => !/\p{Cc}/u.test(arg) && allowed.some(rule => rule.endsWith('*') ? arg.startsWith(rule.slice(0, -1)) : arg === rule))
  if (filtered.length !== args.length) warn?.(args.length - filtered.length)
  return filtered
}
