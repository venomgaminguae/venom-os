/**
 * Compile-time constant: `true` only under scripts/voice-proof.vite.config.mjs,
 * `false` under vite.config.ts (the live app and the build). Read it behind
 * `typeof` so a config that leaves it out also means off.
 */
declare const __VENOM_PROOF_ASK__: boolean | undefined
