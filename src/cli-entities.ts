import { readFile } from 'node:fs/promises'
import { AgentReadinessError } from './errors.js'
import type { EntityRegistry, EntityRegistryEntry, EntityUrlMatcher } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(source: string, problem: string): AgentReadinessError {
  return new AgentReadinessError('BAD_INPUT', `--entities ${source}: ${problem}`)
}

/**
 * The entity registry in an `--entities` file, checked strictly so a typo is reported
 * rather than silently matching nothing: a JSON object with an `entities` array, each
 * entry with a unique non-empty `key`, a `names` array of strings, and optional
 * `urlMatchers` of `{ host, pathPrefix }` with paths starting at `/`. Other fields are
 * ignored.
 */
export function parseEntityRegistry(value: unknown, source: string): EntityRegistry {
  if (!isRecord(value) || !Array.isArray(value.entities)) {
    throw invalid(source, 'expected a JSON object with an "entities" array')
  }
  const keys = new Set<string>()
  const entities: EntityRegistryEntry[] = value.entities.map((entity, index) => {
    const at = `entities[${index}]`
    if (!isRecord(entity)) throw invalid(source, `${at} must be an object`)
    if (typeof entity.key !== 'string' || !entity.key.trim()) throw invalid(source, `${at}.key must be a non-empty string`)
    if (keys.has(entity.key)) throw invalid(source, `${at}.key "${entity.key}" is used by an earlier entity`)
    keys.add(entity.key)
    if (!Array.isArray(entity.names) || !entity.names.every((name) => typeof name === 'string')) {
      throw invalid(source, `${at}.names must be an array of strings`)
    }
    const urlMatchers: EntityUrlMatcher[] = []
    if (entity.urlMatchers !== undefined) {
      if (!Array.isArray(entity.urlMatchers)) throw invalid(source, `${at}.urlMatchers must be an array`)
      entity.urlMatchers.forEach((matcher, matcherIndex) => {
        const where = `${at}.urlMatchers[${matcherIndex}]`
        if (!isRecord(matcher)) throw invalid(source, `${where} must be an object`)
        if (typeof matcher.host !== 'string' || !matcher.host.trim()) throw invalid(source, `${where}.host must be a non-empty string`)
        if (typeof matcher.pathPrefix !== 'string' || !matcher.pathPrefix.startsWith('/')) {
          throw invalid(source, `${where}.pathPrefix must be a string starting with "/"`)
        }
        urlMatchers.push({ host: matcher.host, pathPrefix: matcher.pathPrefix })
      })
    }
    return { key: entity.key, names: entity.names as string[], urlMatchers }
  })
  return { entities }
}

/** Reads and checks an `--entities` file. Every problem is a BAD_INPUT error naming the file. */
export async function readEntityRegistryFile(path: string): Promise<EntityRegistry> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    throw invalid(path, 'the file could not be read')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalid(path, 'the file is not valid JSON')
  }
  return parseEntityRegistry(value, path)
}
