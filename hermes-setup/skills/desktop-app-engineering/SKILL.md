---
name: desktop-app-engineering
description: "Use when building Electron apps. Package and test safely."
version: 1.0.0
---

# Desktop App Engineering (Electron/Node)

## Overview

Guidance for building, packaging, and testing Electron-based desktop applications.

## Development & Packaging

- **Build Pattern:** Use `electron-packager` or `electron-builder`.
- **Portable Releases:** Prefer portable folder releases for user convenience.
- **Shortcut Management:** Ensure the installer or build process creates a reliable desktop shortcut and optionally a Start Menu entry.
- **System Integration:** Implement tray menus (Quit, Show) and Windows startup options.

## Testing & QA

- **Headless/Silent Testing:** When running automated tests, disable audio output and avoid hardware-dependent interactions (like holding a microphone).
- **Visual Verification:** Use screenshots to verify HUD/UI rendering, taskbar icon presence, and window dimensions.

### Pitfalls

- **The "Focus Hijack" (Global Keys):** During automated testing, if the application crashes or exits, any subsequent key presses (like `Esc`) will be sent to whatever window is currently in focus (e.g., Steam, Chrome).
  - *Fix:* Ensure tests only send key events when the application window is confirmed to be in focus and active.
- **The "Memory Ghost" (Dev vs. Package):** Do not run the development server (e.g., `npm run dev` or `Venom.cmd`) at the same time as the packaged desktop application. Both will attempt to write to the same local memory/configuration files, leading to corruption or race conditions.
  - *Fix:* Always close all development instances before launching the packaged app.

## Verification Checklist

- [ ] **Identity:** Custom icon and AppUserModelID are correctly set.
- [ ] **Tray:** Tray menu (Quit/Show) is functional.
- [ ] **Build:** Package is portable and runs from a single folder.
- [ ] **Safety:** No test-induced key/mouse events were sent to the host OS.
- [ ] **Isolation:** No developer processes were running during the packaged app test.
