import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { KOKORO_VOICE } from '../config'
import { voiceLine, type KokoroStatus, type VoiceLine } from '../lib/voicePolicy'

/**
 * The one line in the footer that says which engine is speaking.
 *
 * The owner could not tell the natural voice from the system voice from no
 * voice at all, because nothing on screen said which was in use. This reads
 * the speech diagnostics (window.__tts, a plain mutable object written outside
 * React, same as the D panel) and states it in words. It polls rather than
 * subscribing so it never changes the timing of the speech it is watching.
 */

type LogEntry = {
  at: number
  engine: string
  voice: string
  text: string
  started: boolean
  rms: number
  why: string
}

type TtsSnapshot = {
  kokoro?: KokoroStatus
  systemVoice?: string
  alarm?: string
  log?: LogEntry[]
}

const IDLE: KokoroStatus = { state: 'idle', progress: 0, lastError: '', restWhy: '', restMs: 0 }

function read(): VoiceLine {
  const d = ((window as unknown as { __tts?: TtsSnapshot }).__tts ?? {}) as TtsSnapshot
  const k = d.kokoro ?? IDLE
  const last = d.log && d.log.length ? d.log[d.log.length - 1] : undefined
  const line = voiceLine({
    kokoro: k,
    kokoroVoice: KOKORO_VOICE,
    engine: last?.engine ?? '',
    systemVoice: d.systemVoice ?? '',
    alarm: d.alarm ?? '',
  })
  // Kokoro is up but this one sentence still went to the system voice. Say
  // so, otherwise the line claims the natural voice while you hear the robot.
  if (last && last.engine === 'system' && k.state === 'ready') {
    return { ...line, text: `${line.text} · last sentence: system voice (${last.why})` }
  }
  return line
}

export function VoiceStatus() {
  const [line, setLine] = useState<VoiceLine>(read)
  const lastAlarm = useRef('')

  useEffect(() => {
    const id = setInterval(() => {
      const next = read()
      // Only re-render when what is shown actually changes.
      setLine((cur) => (cur.text === next.text && cur.level === next.level ? cur : next))

      // A sentence nobody could speak goes to the red banner as well, once per
      // new alarm. Errors set by anything else are left alone.
      const d = (window as unknown as { __tts?: TtsSnapshot }).__tts
      const alarm = d?.alarm ?? ''
      if (alarm && alarm !== lastAlarm.current) {
        useStore.getState().setError('Voice failed: ' + alarm + ' Press D for details.')
      }
      lastAlarm.current = alarm
    }, 300)
    return () => clearInterval(id)
  }, [])

  return (
    <span
      className={'voice-status voice-' + line.level}
      title="Which engine is speaking. Press D for the full voice diagnostics."
    >
      {line.text}
    </span>
  )
}
