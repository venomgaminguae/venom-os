#!/usr/bin/env node
// VENOM setup.
//
//   npm run setup                the "choose your brain" wizard (scripts/setup-lib.mjs):
//                                checks prerequisites, lets you pick the model
//                                provider in Hermes's own picker, creates the agent
//                                team and saves the app settings in venom.config.json.
//   npm run setup -- --check     a read-only preflight: changes nothing, always exits 0.
//   npm run setup -- --no-alias  the wizard, but Hermes creates no per-profile commands.
//
// Keys: sign-ins happen only inside Hermes's own prompt. API keys are pasted
// by you into the profile's own .env file in a plain editor (Notepad on
// Windows); the wizard never prints, logs, stores elsewhere or sends a key.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { NODE_MIN, firstSentence, nodeSupported, wizard } from './setup-lib.mjs';
import { RosterError, loadRoster, rosterPath } from '../hermes-mcp/roster.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------- --check

// The read-only preflight: it looks at your machine, tells you what is ready
// and what is missing, and prints the commands that start VENOM. Every check
// degrades to a single friendly line; it is advice, not a gate.
function check() {
  const tick = '  ok  ';
  const warn = ' note ';
  const info = '  ·   ';

  function line(tag, msg) {
    console.log(`[${tag}] ${msg}`);
  }

  console.log('');
  console.log('VENOM preflight: checking your machine (nothing is changed)');
  console.log('------------------------------------------------------------');

  // --- Node version --------------------------------------------------------
  try {
    if (nodeSupported(process.versions.node)) {
      line(tick, `Node.js ${process.versions.node} (${NODE_MIN}+ required).`);
    } else {
      line(warn, `Node.js ${process.versions.node} is below ${NODE_MIN}. Please upgrade: VENOM needs Node ${NODE_MIN} or newer.`);
    }
  } catch {
    line(warn, `Could not read the Node.js version. VENOM needs Node ${NODE_MIN} or newer.`);
  }

  // --- Claude CLI on PATH ---------------------------------------------------
  let claudeFound = false;
  try {
    const res = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (res.status === 0 && res.stdout) {
      claudeFound = true;
      line(tick, `Claude CLI found: ${res.stdout.trim()}`);
    }
  } catch {
    // ignore, handled below
  }
  if (!claudeFound) {
    line(warn, 'Claude CLI not found on your PATH.');
    line(info, 'Install it: npm install -g @anthropic-ai/claude-code');
    line(info, '  (or the platform installer at https://docs.claude.com/en/docs/claude-code)');
    line(info, 'Then run `claude` once and complete login. The bridge uses that login, no API key needed.');
  }

  // --- ~/.claude.json and MCP servers --------------------------------------
  const claudeJsonPath = join(homedir(), '.claude.json');
  let mcpCount = 0;
  try {
    const raw = readFileSync(claudeJsonPath, 'utf8');
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    const servers = parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers ? parsed.mcpServers : {};
    mcpCount = Object.keys(servers).length;
    if (mcpCount > 0) {
      line(tick, `~/.claude.json found with ${mcpCount} MCP server${mcpCount === 1 ? '' : 's'} configured.`);
    } else {
      line(info, '~/.claude.json found, but no MCP servers are configured yet. VENOM still answers and drives its own interface.');
    }
  } catch {
    line(info, '~/.claude.json not found yet. It appears once you run `claude` and log in. VENOM works without any MCP servers.');
  }

  // --- ElevenLabs key (env or the elevenlabs MCP entry) --------------------
  function findElevenLabsKey() {
    if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim()) {
      return 'environment (ELEVENLABS_API_KEY)';
    }
    try {
      const raw = readFileSync(claudeJsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      const servers = parsed && parsed.mcpServers ? parsed.mcpServers : {};
      const el = servers.elevenlabs;
      const env = el && el.env ? el.env : {};
      if (env.ELEVENLABS_API_KEY && String(env.ELEVENLABS_API_KEY).trim()) {
        return 'the elevenlabs MCP server in ~/.claude.json';
      }
    } catch {
      // ignore, no key discoverable
    }
    return null;
  }

  const elSource = findElevenLabsKey();
  if (elSource) {
    line(tick, `Premium voice available: ElevenLabs key found via ${elSource}.`);
  } else {
    line(info, 'No ElevenLabs key found. VENOM will use browser speech (that is completely fine).');
    line(info, '  Optional: add ELEVENLABS_API_KEY for a better voice and Scribe transcription. The free tier is enough for a demo.');
  }

  // --- The team list (venom.agents.json), read only --------------------------
  const teamFile = rosterPath();
  try {
    if (!existsSync(teamFile)) {
      line(info, `Team: no team list at ${teamFile} yet, so the four starter agents are used.`);
    } else {
      const n = loadRoster({ file: teamFile }).agents.length;
      line(tick, `Team: ${teamFile} lists ${n} agent${n === 1 ? '' : 's'}.`);
    }
  } catch (err) {
    const first = err instanceof RosterError && err.errors?.length ? err.errors[0] : String(err?.message ?? err);
    line(warn, `Team: ${teamFile} cannot be used: ${firstSentence(first)}`);
  }

  // --- How to run ----------------------------------------------------------
  console.log('');
  console.log('To run VENOM:');
  console.log('  npm start               # the bridge and the page together, read-only');
  console.log('  then open the printed address (http://localhost:5173) in Chrome');
  console.log('');
  console.log('Then click INITIALISE and say "Hey Venom".');
  console.log('To let VENOM take real actions (shell, files, browser, sending), run `npm start -- --writes` instead.');
  console.log('To choose the brain of the Hermes agent team, run `npm run setup` (without --check) in a terminal.');
  console.log('');
  return 0;
}

// ------------------------------------------------------------- real deps

function which(name) {
  try {
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
    if (res.status !== 0 || !res.stdout) return '';
    const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // On Windows prefer something that starts without a shell.
    return lines.find((l) => /\.(exe|com)$/i.test(l)) ?? lines[0] ?? '';
  } catch {
    return '';
  }
}

// `showWindow` is for a window program such as Notepad: its output stays piped,
// but its window must not be hidden.
function run(cmd, args, { interactive = false, env, showWindow = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        env: env ?? process.env,
        windowsHide: !interactive && !showWindow,
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function ask(question) {
  // One interface per question: it must not hold stdin while Hermes's own
  // picker runs with inherited stdio.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ------------------------------------------------------------- main

const argv = process.argv.slice(2);
if (argv.includes('--check')) {
  process.exit(check());
}
if (!process.stdin.isTTY) {
  console.log('npm run setup is an interactive wizard: run it in a terminal window, not through a pipe.');
  console.log('For the read-only check use: npm run setup -- --check');
  process.exit(1);
}

const code = await wizard({
  platform: process.platform,
  env: process.env,
  nodeVersion: process.versions.node,
  repoRoot: ROOT,
  noAlias: argv.includes('--no-alias'),
  log: (l) => console.log(l),
  ask,
  run,
  fetchJson,
  fetchText,
  exists: (p) => existsSync(p),
  which,
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, text) => writeFileSync(p, text),
  copyFile: (src, dest) => copyFileSync(src, dest),
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  rename: (from, to) => renameSync(from, to),
  remove: (p) => rmSync(p, { force: true }),
  now: () => new Date(),
  nowMs: () => Date.now(),
  randomHex: () => randomBytes(4).toString('hex'),
  homedir: homedir(),
});
process.exit(code);
