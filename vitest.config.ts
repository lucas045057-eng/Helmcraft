import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const workspaces = ['protocol', 'common', 'hub', 'worker', 'mock-cli', 'dashboard']
const alias = workspaces.flatMap((name) => {
  const prefix = '@agent-hub/' + name
  const src = fileURLToPath(new URL('./packages/' + name + '/src/', import.meta.url)).replaceAll('\\', '/')
  return [
    { find: new RegExp('^' + prefix + '$'), replacement: src + 'index.ts' },
    { find: new RegExp('^' + prefix + '/(.+)$'), replacement: src + '$1.ts' },
  ]
})

export default defineConfig({
  resolve: { alias },
  test: {
    projects: workspaces.map((name) => ({
      extends: true,
      test: { name, include: [`packages/${name}/test/**/*.test.ts`] },
    })),
  },
})
