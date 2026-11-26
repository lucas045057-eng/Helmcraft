import { expect, it } from 'vitest'
import type { ProjectOverview } from '@agent-hub/protocol'
import { defaultWorkspace } from '../src/ProjectHub.js'

const project = (workspaceId: string, subdir?: string) => ({ workspaceId, ...(subdir && { subdir }) }) as ProjectOverview

it('opens the workspace that holds the most project folders by default', () => {
  expect(defaultWorkspace([project('sandbox'), project('soren'), project('soren', 'Forma'), project('soren', 'Notes'), project('daily'), project('daily', 'x')]))
    .toBe('soren')
})

it('falls back to all workspaces when no workspace has project folders', () => {
  expect(defaultWorkspace([project('sandbox'), project('daily')])).toBe('')
})
