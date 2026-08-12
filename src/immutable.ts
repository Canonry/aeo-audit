/**
 * Freeze a value and everything reachable from it, and return it.
 *
 * A published constant that internal logic also reads is a runtime widening
 * surface: a consumer who mutates it changes engine behavior while every
 * version string still reports the old ruleset, which makes the resulting
 * report unreproducible and the drift invisible. `readonly` and `Readonly<T>`
 * are compile-time only and do not prevent that, so shared constants are frozen
 * for real.
 *
 * `Object.freeze` does NOT stop `Set.add` or `Map.set`. A collection that must
 * be immutable has to be exposed as a frozen array plus a predicate rather than
 * as the live instance.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  // Also terminates on a cycle, since the object is frozen before its children.
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
