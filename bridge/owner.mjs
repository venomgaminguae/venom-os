/**
 * Who the assistant works for: the owner's name, company and city, which the
 * persona prompt (bridge/server.mjs) mentions. Nothing here is required. In
 * order of priority, each value comes from
 *
 *   1. the environment: VENOM_OWNER_NAME, VENOM_COMPANY, VENOM_CITY;
 *   2. venom.config.json at the repo root (optional, not committed; copy
 *      venom.config.example.json): { "ownerName", "company", "city" };
 *   3. neutral defaults: "the owner", no company, no city.
 *
 * Every value ends up inside the system prompt, so it is treated as untrusted
 * text: control characters and line breaks become spaces, runs of whitespace
 * collapse, and it is cut to OWNER_CAP characters. A value that is empty after
 * that falls through to the next source.
 *
 * Pure apart from the injected readFile: no other I/O, no dependencies.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const OWNER_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'venom.config.json')
export const OWNER_CAP = 80
export const OWNER_DEFAULTS = Object.freeze({ ownerName: 'the owner', company: '', city: '' })

const ENV_KEYS = { ownerName: 'VENOM_OWNER_NAME', company: 'VENOM_COMPANY', city: 'VENOM_CITY' }

/** One line of plain text, at most `cap` characters; anything not a string is ''. */
export function cleanOwnerText(value, cap = OWNER_CAP) {
  if (typeof value !== 'string') return ''
  const flat = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(flat).slice(0, cap).join('').trim()
}

/**
 * The parsed config file, or {} when it is missing, unreadable, not JSON or
 * not a JSON object. `warn` hears about a file that exists but is broken.
 */
export function readConfig(readFile, file, warn) {
  let text
  try {
    text = readFile(file)
  } catch {
    return {}
  }
  try {
    const data = JSON.parse(String(text).replace(/^\uFEFF/, ''))
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
    warn(`${file} is not a JSON object; using the defaults`)
  } catch (err) {
    warn(`${file} is not valid JSON (${err.message}); using the defaults`)
  }
  return {}
}

/** { ownerName, company, city }, each a clean single line (see the top of this file). */
export function loadOwner({
  env = process.env,
  readFile = (p) => readFileSync(p, 'utf8'),
  file = OWNER_FILE,
  warn = () => {},
} = {}) {
  const config = readConfig(readFile, file, warn)
  const owner = {}
  for (const [key, envKey] of Object.entries(ENV_KEYS)) {
    owner[key] = cleanOwnerText(env?.[envKey]) || cleanOwnerText(config[key]) || OWNER_DEFAULTS[key]
  }
  return owner
}

/**
 * The persona's opening lines for this owner. With no company: a personal
 * assistant. With one: the artificial intelligence of that company (and its
 * city, when set).
 */
export function ownerIntro({ ownerName, company, city } = OWNER_DEFAULTS) {
  const who = ownerName || OWNER_DEFAULTS.ownerName
  if (!company) {
    return `You are VENOM OS, a personal AI assistant. You run a team of AI agents for ${who}.`
  }
  const where = city ? `, based in ${city}` : ''
  return `You are VENOM OS, the artificial intelligence of ${company}${where}. You run its AI team for ${who}.`
}

/** How the assistant describes itself when asked who it is. */
export const ownerSelf = ({ company } = OWNER_DEFAULTS) =>
  company ? `the AI of ${company}` : 'a personal AI assistant'
