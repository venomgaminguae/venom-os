import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { caps } from '../lib/capabilities'
import { whyNotKokoro, type KokoroStatus } from '../lib/voicePolicy'

/**
 * The "why can't he hear me / why can't I hear him" panel.
 *
 * Both halves of the voice loop fail silently by nature. Speech recognition
 * that ignores you and speech synthesis that produces no sound look identical
 * from the outside — nothing throws, nothing logs, the interface carries on as
 * though it were working. Every bug in this loop has therefore cost a round
 * trip of guesswork, and that is the actual problem this fixes: it is not a
 * developer toy, it is the instrument that turns "it doesn't work" into a
 * specific, answerable fact.
 *
 * Press D to show it. It polls rather than subscribing, because the two
 * diagnostic records are plain mutable objects written from outside React —
 * that is deliberate, since the whole point is to observe the loop without
 * changing its timing.
 */

type VoiceDiag = {
  engine: string
  wakeRoute: string
  fallback: string
  running: boolean
  sessions: number
  heard: string
  heardAt: number
  lastError: string
  wakes: number; wokeBy?: string
  mode: string
  dropped: string
  accepted: number
  restarts: number
  idleMs: number
}

type TtsDiag = {
  engine: string
  spoken: number
  started: number
  failures: number
  lastError: string
  nativeBroken: boolean
  rescued: number
  voice: string
  lastText: string
  why: string
  silent: number
  alarm: string
  systemVoice: string
  log: { at: number; engine: string; voice: string; text: string; started: boolean; rms: number; why: string }[]
  kokoro: KokoroStatus & {
    loadMs: number
    warmMs: number
    rests: number
    generated: number
    device: string
    dtype: string
    rtf: number
    lastMs: number
  }
}

const ago = (t: number) => (t ? `${((Date.now() - t) / 1000).toFixed(1)}s ago` : '—')

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="diag-row">
      <span className="diag-k">{k}</span>
      <span className={bad ? 'diag-v diag-bad' : 'diag-v'}>{v}</span>
    </div>
  )
}

export function Diagnostics() {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const phase = useStore((s) => s.phase)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'd' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [open])

  if (!open) return null

  const w = window as unknown as Record<string, unknown>
  const v = (w.__voice ?? {}) as Partial<VoiceDiag>
  const t = (w.__tts ?? {}) as Partial<TtsDiag>

  // Which voice is speaking and why it is not the natural one, stated in words.
  const k = t.kokoro
  const natural = !k
    ? '—'
    : k.state === 'ready'
      ? `ready · load ${k.loadMs} ms · warm-up ${k.warmMs} ms · last ${k.rtf}x realtime`
      : `${k.state} · ${whyNotKokoro(k)}`
  const lastSaid = t.log && t.log.length ? t.log[t.log.length - 1] : undefined

  // The two verdicts worth stating outright, rather than making you infer them
  // from the numbers underneath.
  const earsOk = Boolean(v.running) && (v.accepted ?? 0) > 0
  const mouthOk = (t.started ?? 0) > 0 || (t.rescued ?? 0) > 0

  // Which engine is hearing you right now. "Local" is a privacy claim, so the
  // panel names the model and device rather than just asserting it.
  const c = caps()
  const hearing =
    v.engine === 'local'
      ? ['local Whisper', c.sttModel, c.sttDevice].filter(Boolean).join(' · ')
      : v.engine === 'elevenlabs'
        ? 'ElevenLabs Scribe'
        : v.fallback
          ? `Chrome recognition (fallback: ${v.fallback})`
          : 'Chrome recognition'
  const wakeBy =
    v.wakeRoute === 'local'
      ? 'local Whisper'
      : v.wakeRoute === 'n/a'
        ? 'ElevenLabs Scribe'
        : v.engine === 'local'
          ? 'Chrome recognition, local Whisper as backup'
          : 'Chrome recognition'

  return (
    <div className="diag" aria-live="polite">
      <div className="diag-head">DIAGNOSTICS · D to close</div>

      <div className="diag-verdict">
        <span className={earsOk ? 'diag-ok' : 'diag-bad'}>
          {earsOk ? '● hearing you' : '● not hearing you'}
        </span>
        <span className={mouthOk ? 'diag-ok' : 'diag-bad'}>
          {mouthOk ? '● speaking' : '● no sound produced'}
        </span>
      </div>

      <div className="diag-sec">LISTENING</div>
      <Row k="hearing" v={hearing} bad={Boolean(v.fallback)} />
      <Row k="wake word" v={wakeBy} />
      <Row k="recogniser" v={v.running ? 'running' : 'STOPPED'} bad={!v.running} />
      <Row k="sessions" v={String(v.sessions ?? 0)} />
      <Row
        k="silent for"
        v={`${((v.idleMs ?? 0) / 1000).toFixed(1)}s`}
        bad={(v.idleMs ?? 0) > 15000}
      />
      <Row k="forced restarts" v={String(v.restarts ?? 0)} bad={(v.restarts ?? 0) > 0} />
      <Row k="mode" v={`${v.mode ?? '—'} (phase ${phase})`} />
      <Row k="accepted" v={String(v.accepted ?? 0)} bad={(v.accepted ?? 0) === 0} />
      <Row k="wakes" v={`${v.wakes ?? 0}${v.wokeBy ? ` (last as "${v.wokeBy}")` : ''}`} />
      <Row k="last heard" v={v.heard ? `"${v.heard}" ${ago(v.heardAt ?? 0)}` : '— nothing yet'} bad={!v.heard} />
      <Row k="last drop" v={v.dropped || '—'} bad={Boolean(v.dropped)} />
      <Row k="error" v={v.lastError || '—'} bad={Boolean(v.lastError)} />

      <div className="diag-sec">SPEAKING · press T to test</div>
      <Row k="engine" v={String(t.engine ?? 'system')} />
      <Row k="voice" v={String(t.voice || '—')} />
      <Row k="handed to engine" v={String(t.spoken ?? 0)} />
      <Row k="actually spoke" v={String(t.started ?? 0)} bad={(t.started ?? 0) === 0} />
      <Row k="natural voice" v={natural} bad={k?.state === 'failed' || k?.state === 'resting'} />
      <Row k="fallback voice" v={t.systemVoice || '—'} />
      <Row
        k="last sentence"
        v={
          lastSaid
            ? `${lastSaid.engine} · ${lastSaid.started ? 'sounded' : 'NO SOUND'} · level ${lastSaid.rms >= 0 ? lastSaid.rms.toFixed(3) : 'n/a'}`
            : '— nothing yet'
        }
        bad={Boolean(lastSaid) && !lastSaid?.started}
      />
      {t.why ? <Row k="why not natural" v={t.why} /> : null}
      <Row k="unspoken" v={String(t.silent ?? 0)} bad={(t.silent ?? 0) > 0} />
      <Row k="rests" v={String(k?.rests ?? 0)} />
      <Row k="failures" v={String(t.failures ?? 0)} bad={(t.failures ?? 0) > 0} />
      <Row k="cloud rescues" v={String(t.rescued ?? 0)} />
      <Row k="error" v={t.lastError || '—'} bad={Boolean(t.lastError)} />
    </div>
  )
}
