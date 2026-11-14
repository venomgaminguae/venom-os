import { useEffect, useState } from 'react'
import { cycleMic, type MicSnapshot } from '../lib/audio'
import { meterFill, micLine, realInputs, type MicLine } from '../lib/micPolicy'

/**
 * The line under the voice line that says which microphone VENOM hears and
 * whether anything is arriving on it, with a small level meter.
 *
 * The owner was never heard because the page listened on a silent headset
 * microphone and nothing on screen said so. This reads window.__mic (a plain
 * mutable object written by audio.ts, outside React) and polls it, like
 * VoiceStatus, so it never changes the timing of what it watches. M cycles
 * through the inputs.
 */

type View = { line: MicLine; fill: number }

function read(): View {
  const w = window as unknown as {
    __mic?: MicSnapshot
    __voice?: { engine?: string; running?: boolean }
  }
  const m = w.__mic
  if (!m) {
    return {
      line: micLine({ state: 'starting', label: '', why: '', count: 0, honoured: true }),
      fill: 0,
    }
  }
  const line = micLine({
    state: m.state,
    label: m.label,
    why: m.why,
    count: realInputs(m.inputs).length,
    // Only once the voice loop is running on Chrome's recogniser: `engine`
    // reads 'browser' before the loop has started, whichever engine follows.
    honoured: !(w.__voice?.running && w.__voice.engine === 'browser'),
    note: m.note,
  })
  // Between the instant level and the recent peak, so speech reads clearly
  // without the bar sticking at the top for three seconds.
  const level = Math.max(m.rms, m.peak * 0.5)
  return { line, fill: Math.round(meterFill(level) * 50) / 50 }
}

export function MicStatus() {
  const [view, setView] = useState<View>(read)

  useEffect(() => {
    const id = setInterval(() => {
      const next = read()
      setView((cur) =>
        cur.line.text === next.line.text && cur.line.level === next.line.level && cur.fill === next.fill
          ? cur
          : next,
      )
    }, 150)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'm' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        void cycleMic()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <span
      className={'mic-status voice-' + view.line.level}
      title="Which microphone VENOM hears, and its level. Press M for the next microphone."
    >
      <span className="mic-meter">
        <span className="mic-meter-fill" style={{ width: `${Math.round(view.fill * 100)}%` }} />
      </span>
      {view.line.text}
    </span>
  )
}
