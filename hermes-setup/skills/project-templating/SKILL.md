---
name: project-templating
description: Use when sharing a project publicly. Make a clean copy.
version: 1.1.0
license: MIT
---

# Project Templating (Clean Shareable Copy)

## Overview

When a repository or project folder is shared with others, it must be a "clean copy": ready to run immediately, but without the original owner's private data, secrets or machine-specific configuration.

## The Clean-Copy Workflow

### 1. Scrubbing (security and privacy)
**Mandatory.** Before any commit or share, scan for and remove:
- **Secrets:** API keys, tokens, account ids and password-related environment variables.
- **Identity:** personal names, business names, specific locations, user handles and e-mail addresses.
- **Paths:** absolute Windows/macOS paths that reveal a user name (for example `%USERPROFILE%\...` written out in full).
- **Connectors:** account connections (social networks, design tools, mail) tied to the owner's identity.

Keep the list of private terms in a file outside the shared copy and scan every file against it on each rebuild; a scan that is not repeated misses what new files bring in.

**Pitfall:** leaving a `.env` with a placeholder value that looks like a real key. Ship an empty template (`.env.example`) listing the settings, not a file with "YOUR_KEY_HERE".

### 2. The setup wizard (configuration)
Instead of hard-coding defaults, give the new user a first-run setup.
- **Brain/model selection:** ask which provider and model they want (GPT, Claude, Gemini, local) and apply it with the system's own CLI (`hermes model`, `hermes config`).
- **Credentials:** ask first how the person wants to connect, because the two routes are billed differently: a subscription sign-in (through the system's own sign-in) or API keys (pay per use, separate from any plan). Say that difference on screen in one line. For the API-key route, the wizard can open the `.env` for them: back the file up, prepare the empty `NAME=` line, open it in a fresh editor window, then check that the line is filled and that no other line was lost (an editor holding an old copy can silently drop other keys on save; restore them from the backup). The wizard never prints, logs, copies or sends the value.
- **Hardware/preferences:** ask for microphone/speaker choices or "start with Windows".

**Pitfall:** hard-coding the owner's preferred model id or hardware brand as the default in the setup script or README. Leave such defaults empty and let the wizard fill them.

### 3. Documentation (README)
- Clear installation steps (`npm ci`, etc.).
- How to start the setup wizard.
- Honest notes on parts that still need a specific login (for example a component tied to one vendor whatever brain is chosen).

### 4. Repository hygiene
- **Single commit:** the shareable copy starts as one clean commit.
- **No remotes:** no `origin` or other remote is set.
- **Placeholder author:** use a generic author for that commit.

### 5. Where the work happens
- Never run a setup wizard, profile script or installer against your real home folder or real agent profiles while testing: a profile script can overwrite the agents' briefs. Use a fake CLI or a throwaway home.
- The first screen of the README must be enough for a stranger: what you need, the few commands, what the wizard asks. Keep the long reference below it.
- State limits early in the wizard, at the question they affect, not at the end.

## Verification Checklist

- [ ] **Secret scan:** no keys, tokens or id-shaped strings found.
- [ ] **Identity scan:** no personal names, e-mail addresses or user paths found.
- [ ] **Zero-config test:** a fresh clone installs and reaches the first-run state without errors.
- [ ] **Setup wizard test:** the wizard applies the choices to the system's configuration.
- [ ] **README check:** setup steps and limitations are clearly stated.
