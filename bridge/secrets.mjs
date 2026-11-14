/**
 * What looks like a secret: API keys, tokens, private keys, card numbers and
 * "password is ..." phrases. One pattern, shared by the memory tools (which
 * refuse to save a hit) and the team activity log (which redacts one).
 * Dependency-free so the Hermes connector can import it too.
 */
export const SECRET =
  /(\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-|-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:\d[ -]?){13,19}\b|\b(password|passcode|passphrase|pin code|api[ _-]?key|secret key|access token)\s*(is|:|=)\s*\S)/i

/** The same pattern, extended to the end of the token it starts in, so the
 *  whole value goes rather than only its first character. */
const SECRET_ALL = new RegExp(`(?:${SECRET.source})\\S*`, 'gi')

/** `text` with every hit replaced by `[redacted]`. */
export const redactSecrets = (text) => String(text ?? '').replace(SECRET_ALL, '[redacted]')
