import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { HubConfigSchema } from './schema.js'
export function loadHubConfig(path = 'hub.yaml') {
  return HubConfigSchema.parse(parse(readFileSync(path, 'utf8')))
}
