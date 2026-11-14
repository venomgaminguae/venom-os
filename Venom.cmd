@echo off
rem Starts VENOM: the voice app in your browser, with Claude Code (your own
rem login) running the voice app, and a team of Hermes agents as its tool
rem (researcher, coder, operator, writer, each with its own workers) running
rem on whatever brain `npm run setup` chose.
rem The voice app model: VENOM_MODEL if set, else appModel in venom.config.json,
rem else Claude Code's own default. Nothing here names a model.
rem Read-only by default. To let VENOM act (needed for the agent tool; see
rem bridge\policy.mjs), run `set VENOM_ALLOW_WRITES=1` before this file, or
rem change the last line to: npm start -- --writes --window
title VENOM
cd /d "%~dp0"
if not defined VENOM_MCP_SERVERS set VENOM_MCP_SERVERS=hermes,context7,firecrawl,sequential-thinking
rem Drop Claude settings inherited from other apps so your own login is used.
set ANTHROPIC_API_KEY=
set ANTHROPIC_BASE_URL=
set CLAUDECODE=
rem Terminal/debug mode: runs the servers here with their log visible, and opens
rem the Venom app window in Google Chrome, full screen, once the servers are
rem ready (--window). A second start does not open a second window: Chrome's
rem lock on the app profile shows one is already open. F11 leaves full screen;
rem Esc stands the assistant down. set VENOM_WINDOWED=1 for a normal window.
echo The Venom window opens full screen once the servers are ready (F11 leaves full screen).
npm start -- --window
