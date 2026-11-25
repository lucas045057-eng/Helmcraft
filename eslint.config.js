import tseslint from 'typescript-eslint'

const within = (path, folder) => path.replaceAll('\\', '/').includes(folder)
const member = (node, key) => node?.type === 'MemberExpression' &&
  ((!node.computed && node.property.name === key) || (node.computed && node.property.value === key))
const property = (node, key) => node?.type === 'Property' &&
  ((!node.computed && node.key.name === key) || node.key.value === key)

const local = {
  rules: {
    'cordis-plugin-api': {
      create(context) {
        if (!within(context.filename, '/plugins/')) return {}
        return {
          CallExpression(node) {
            if (member(node.callee, 'plugin') && node.callee.object.name === 'ctx') {
              context.report({ node, message: 'Use ctx.use() for plugins.' })
            }
            if (member(node.callee, 'on') && node.callee.object.name === 'ctx') {
              const event = node.arguments[0]
              if (event?.type === 'Literal' && typeof event.value === 'string' && event.value.startsWith('internal/')) {
                context.report({ node, message: 'Cordis internal events belong in kernel/.' })
              }
            }
          },
        }
      },
    },
    'safe-events': {
      create(context) {
        if (within(context.filename, '/kernel/')) return {}
        return {
          CallExpression(node) {
            if (!member(node.callee, 'on')) return
            const receiver = node.callee.object
            if (receiver.name === 'ctx' || member(receiver, 'ctx')) {
              context.report({ node, message: 'Use safeOn() for Cordis listeners.' })
            }
          },
        }
      },
    },
    'no-shell-true': {
      create(context) {
        return {
          Property(node) {
            if (property(node, 'shell') && node.value.type === 'Literal' && node.value.value === true) {
              context.report({ node, message: 'Spawn executables directly with shell disabled.' })
            }
          },
        }
      },
    },
    'orchestrator-timers': {
      create(context) {
        if (!within(context.filename, '/plugins/orchestrator/')) return {}
        return {
          Identifier(node) {
            if (node.name === 'setTimeout') context.report({ node, message: 'Use TimerWheel and the injected clock.' })
          },
          Literal(node) {
            if (node.value === 'setTimeout') context.report({ node, message: 'Use TimerWheel and the injected clock.' })
          },
        }
      },
    },
  },
}

export default [
  { ignores: ['**/dist/**', '**/coverage/**', '**/test/fixtures/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.tsx'], languageOptions: { parser: tseslint.parser } },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    plugins: { local },
    rules: {
      'local/cordis-plugin-api': 'error',
      'local/safe-events': 'error',
      'local/no-shell-true': 'error',
      'local/orchestrator-timers': 'error',
    },
  },
]
