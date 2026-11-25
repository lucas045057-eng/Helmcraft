const pkg = (name) => '^packages/' + name + '/'
const workspaceDependency = (name) => '(?:^packages/' + name + '/|node_modules/@agent-hub/' + name + '/)'
const workspaceTarget = '(?:^packages/|node_modules/@agent-hub/)'
const edges = {
  protocol: ['protocol'],
  common: ['common', 'protocol'],
  hub: ['hub', 'common', 'protocol'],
  worker: ['worker', 'common', 'protocol', 'mock-cli'],
  dashboard: ['dashboard', 'protocol'],
  'mock-cli': ['mock-cli'],
}

module.exports = {
  forbidden: [
    ...Object.entries(edges).map(([name, allowed]) => ({
      name: name + '-workspace-boundary',
      severity: 'error',
      from: { path: pkg(name) },
      to: { path: workspaceTarget, pathNot: allowed.map(workspaceDependency).join('|') },
    })),
    {
      name: 'protocol-only-zod',
      severity: 'error',
      from: { path: pkg('protocol') },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-no-pkg', 'npm-unknown', 'core'], pathNot: '(?:node_modules/zod/|\\.pnpm/zod@)' },
    },
    {
      name: 'common-only-protocol',
      severity: 'error',
      from: { path: pkg('common') },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-no-pkg', 'npm-unknown'], pathNot: workspaceDependency('protocol') },
    },
    { name: 'feishu-sdk-transport-only', severity: 'error', from: { pathNot: '^packages/hub/src/plugins/channel-feishu/transport\\.ts$' },
      to: { path: 'node_modules/@larksuiteoapi/node-sdk/|\\.pnpm/@larksuiteoapi\\+node-sdk@' } },
    { name: 'resolves', severity: 'error', from: {}, to: { couldNotResolve: true } },
  ],
  options: {
    includeOnly: '^packages/|node_modules/',
    exclude: '(^|/)(?:test|fixtures)/',
    doNotFollow: { path: 'node_modules|/dist/' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
  },
}
