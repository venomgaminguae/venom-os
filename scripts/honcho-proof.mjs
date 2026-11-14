#!/usr/bin/env node
/**
 * Proof that VENOM's long-term memory reaches the real service, end to end,
 * through the same layer the bridge uses (bridge/longmemory.mjs with the
 * Honcho provider), with the owner's real settings.
 *
 *   node scripts/honcho-proof.mjs            read only: reachability, profile, one search
 *   node scripts/honcho-proof.mjs --write    also stores ONE clearly marked test exchange
 *                                            in the owner's real memory and finds it again
 *   node scripts/honcho-proof.mjs --find "<text>"   search for this text instead
 *
 * It never prints the key, and its waiting list lives in a temp folder, so the
 * bridge's own outbox is not touched. Not a test: `npm test` never runs it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHonchoProvider, honchoConfig, sessionIdFor } from '../bridge/honcho.mjs'
import { createLongMemory, formatRecall } from '../bridge/longmemory.mjs'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const findAt = args.indexOf('--find')
const FIND = findAt >= 0 ? String(args[findAt + 1] ?? '') : ''

const cfg = honchoConfig()
if (!cfg.enabled) {
  console.log(`long-term memory is off: ${cfg.why}`)
  process.exit(2)
}
const provider = createHonchoProvider(cfg)
console.log(`provider: ${provider.label} · ${provider.describe()} · key: set (${cfg.apiKey.length} chars, not shown)`)

const dir = mkdtempSync(join(tmpdir(), 'venom-honcho-proof-'))
const quiet = { log() {}, error: (...a) => console.error(...a) }
const mem = createLongMemory({ provider, dir, log: quiet })
const ms = (t0) => Math.round(performance.now() - t0)
const sleep = (n) => new Promise((r) => setTimeout(r, n))
let failed = false

try {
  const ping = await mem.start()
  console.log(`1. reachable: ${ping.ok ? 'yes' : 'NO'} (${ping.ms} ms)${ping.ok ? '' : ' · ' + ping.error}`)
  if (!ping.ok) throw new Error('not reachable')

  let t0 = performance.now()
  const prof = await provider.profile({})
  console.log(
    `2. profile: ${prof.card.length} card line(s), representation ${prof.representation.length} chars (${ms(t0)} ms; content not printed)`,
  )

  let needle = FIND
  if (WRITE) {
    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    const word = `link-${now.getTime().toString(36)}`
    needle = `Venom OS memory link test ${word}`
    const user = `Venom OS memory link test, ${day}. This is an automatic check that voice memory reaches Honcho, not a real request. The check word is ${word}.`
    const assistant = `Understood. This is the Venom OS memory link test of ${day}; the check word is ${word}. Nothing here needs remembering.`
    t0 = performance.now()
    const id = mem.storeTurn({ session: 'honcho-proof', user, assistant, ts: now })
    const queuedIn = ms(t0)
    await mem.flush()
    const st = mem.status()
    console.log(
      `3. write: storeTurn returned in ${queuedIn} ms (id ${id ? 'given' : 'none'}); sent in ${ms(t0)} ms · sent ${st.sent}, waiting ${st.queued}, state ${st.state}${st.lastError ? ' · ' + st.lastError : ''}`,
    )
    if (st.sent !== 1) throw new Error('the test exchange was not accepted; nothing was stored')
    console.log(`   stored in session ${sessionIdFor(now)} · check word ${word}`)
  } else {
    console.log('3. write: skipped (run with --write to store one marked test exchange)')
  }

  if (needle) {
    // The service indexes a new message in the background: ask a few times.
    let found = null
    let tries = 0
    let last = 0
    const began = performance.now()
    while (!found && tries < 12) {
      tries++
      t0 = performance.now()
      const r = await mem.recall(needle, { limit: 8 })
      last = ms(t0)
      if (!r.ok) console.log(`   recall try ${tries}: failed (${r.error})`)
      const word = needle.split(' ').pop()
      found = r.ok ? (r.hits.filter((h) => h.text.includes(WRITE ? word : needle)).length ? r : null) : null
      if (!found) await sleep(2500)
    }
    if (found) {
      const word = needle.split(' ').pop()
      const mine = found.hits.filter((h) => h.text.includes(WRITE ? word : needle))
      console.log(
        `4. recall: found ${mine.length} matching message(s) on try ${tries}, ${ms(began)} ms after the first ask; that recall call took ${last} ms`,
      )
      for (const h of mine) console.log(`   ${h.when} · ${h.session} · ${h.who}: ${h.text.slice(0, 110)}`)
      const text = formatRecall(found)
      console.log(`   memory_recall would return ${text.length} chars to the brain (${found.hits.length} hit(s), profile ${found.profile ? 'included' : 'missing'})`)
    } else {
      failed = true
      console.log(`4. recall: NOT found after ${tries} tries (${ms(began)} ms)`)
    }
  } else {
    t0 = performance.now()
    const r = await mem.recall('Venom OS', { limit: 5 })
    console.log(
      `4. recall (read only): ${r.ok ? 'ok' : 'FAILED ' + r.error}, ${r.hits.length} hit(s) in ${ms(t0)} ms; sessions: ${[...new Set(r.hits.map((h) => h.session))].join(', ') || 'none'}`,
    )
    if (!r.ok) failed = true
  }
} catch (err) {
  failed = true
  console.log(`stopped: ${err?.message ?? err}`)
} finally {
  mem.stop()
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
