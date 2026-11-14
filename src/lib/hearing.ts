/**
 * The pure decisions behind local hearing, kept import-free so node:test can
 * load this file directly (see test/hearing.test.mjs). voice.ts owns the
 * microphone and the network; this owns the rules, which are the part worth
 * pinning down with tests.
 */

export type WakeRoute = 'browser' | 'local' | 'n/a'

/**
 * Who listens for his name.
 *
 * Only local hearing has a choice. ElevenLabs keeps taking the wake word from
 * its own Scribe transcripts as it always has, so the setting does not apply
 * ('n/a'), and the Chrome engine is the wake route by definition. A browser
 * with no SpeechRecognition cannot take the wake word, so local does.
 */
export function wakeRouteFor(
  engine: 'local' | 'elevenlabs' | 'browser',
  preferred: 'browser' | 'local',
  hasRecognition: boolean,
): WakeRoute {
  if (engine === 'browser') return 'browser'
  if (engine === 'elevenlabs') return 'n/a'
  return preferred === 'browser' && hasRecognition ? 'browser' : 'local'
}

/**
 * The request inside the breath that woke him, in the hybrid setup.
 *
 * Chrome fires on the first partial that holds his name, usually before the
 * rest of "Venom, what's the weather" has been said, so Chrome's own trailing
 * words are not the request. The whole breath is one VAD segment that began
 * while dormant; Whisper transcribes it and this keeps what followed the name.
 * Empty means he only said the name. When Whisper did not catch the name at
 * all (Chrome did), the words are kept as they are rather than thrown away.
 */
export function wakeBreathCommand(said: string, nameFound: boolean, afterName: string): string {
  return (nameFound ? afterName : said).trim()
}

/**
 * Consecutive-failure latch for the local transcriber.
 *
 * One failure is a hiccup; a run of them means the engine is not going to work
 * this session, and it is better to drop to Chrome once and stay there than to
 * keep a deaf assistant on screen. Any success resets the run. An empty
 * transcript is a success: silence is not a broken engine.
 */
export function makeFailureRun(limit = 3) {
  let run = 0
  return {
    /** Record a failure; true exactly when the run reaches the limit. */
    fail(): boolean {
      run++
      return run === limit
    },
    ok(): void {
      run = 0
    },
    count: () => run,
  }
}
