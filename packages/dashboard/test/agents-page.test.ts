import { expect, it } from 'vitest'
import { compact } from '../src/AgentsPage.js'

it('formats token counts compactly', () => {
  expect([0, 999, 1234, 1_911_460, 2_500_000_000].map(compact)).toEqual(['0', '999', '1.2K', '1.9M', '2.5B'])
})
