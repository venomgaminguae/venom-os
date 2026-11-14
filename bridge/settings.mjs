/**
 * App settings for the voice app (the bridge), read the same way as the owner
 * details in bridge/owner.mjs. Nothing here is required.
 *
 * appModel: the Claude model id the bridge asks the Claude Agent SDK for. In
 * order of priority it comes from
 *
 *   1. the environment: VENOM_MODEL;
 *   2. venom.config.json at the repo root: { "appModel" } (`npm run setup`
 *      writes it; it is git-ignored);
 *   3. nothing: '' means "do not name a model", so Claude Code uses its own
 *      default for the signed-in account.
 *
 * A value has to look like a model id (letters, digits and . _ : / -, at most
 * 100 characters). Anything else is ignored with a warning and the next source
 * is tried; a blank value counts as not set.
 *
 * The Hermes supervisor profile name is not read here: nothing in bridge/ or
 * hermes-mcp/ calls the supervisor profile by name (the connector runs the
 * agents' own profiles), so there is nothing for such a setting to change.
 *
 * Pure apart from the injected readFile: no other I/O, no dependencies.
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { OWNER_FILE, readConfig } from './owner.mjs'

export const SETTINGS_FILE = OWNER_FILE
export const MODEL_ID = /^[A-Za-z0-9._:/-]{1,100}$/

/**
 * A model id, or '' when the value is not set (not a string, or blank). A
 * value that is set but is not model-id shaped is '' too, and `warn` hears
 * about it, naming `source` but never echoing the value itself.
 */
export function cleanModelId(value, { warn = () => {}, source = 'model' } = {}) {
  if (typeof value !== 'string') {
    if (value !== undefined && value !== null) warn(`${source} is not a string; ignored`)
    return ''
  }
  const id = value.trim()
  if (!id) return ''
  if (MODEL_ID.test(id)) return id
  warn(`${source} does not look like a model id; ignored`)
  return ''
}

/** The model id for the voice app, or '' for Claude Code's default (see the top of this file). */
export function loadAppModel({
  env = process.env,
  readFile = (p) => readFileSync(p, 'utf8'),
  file = SETTINGS_FILE,
  warn = () => {},
} = {}) {
  const fromEnv = cleanModelId(env?.VENOM_MODEL, { warn, source: 'VENOM_MODEL' })
  if (fromEnv) return fromEnv
  const config = readConfig(readFile, file, warn)
  return cleanModelId(config.appModel, { warn, source: `appModel in ${file}` })
}
