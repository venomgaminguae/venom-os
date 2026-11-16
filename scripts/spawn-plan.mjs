/**
 * How to start a program on Windows when its path is a .cmd or .bat file.
 *
 * Node refuses to spawn a batch file directly (it answers `spawn EINVAL`), so
 * such a program has to go through cmd.exe, and every argument has to be
 * escaped for cmd.exe first. Hermes can be installed as `hermes.cmd`, and
 * HERMES_EXE may point at one, so the setup wizard starts every program
 * through this plan. Anything else (an .exe, or any program on another
 * system) is started as it is.
 *
 * The escaping is the one the `cross-spawn` package uses (MIT, Andre Cruz):
 * quote the argument, double the backslashes in front of a quote, then put a
 * caret in front of every character cmd.exe treats specially. A batch file
 * hands its arguments on with %*, which parses them a second time, so the
 * arguments get the caret step twice.
 *
 * Pure: no I/O.
 */

const META = /([()\][%!^"`<>&|;, *?])/g

const escapeCommand = (cmd) => cmd.replace(META, '^$1')

function escapeArgument(value) {
  let arg = `${value}`
  // Backslashes in front of a quote are doubled, and the quote is escaped.
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  // Backslashes at the end are doubled: they would escape the closing quote.
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1')
  arg = `"${arg}"`
  // Twice: once for cmd.exe, once for the batch file's own %*.
  return arg.replace(META, '^$1').replace(META, '^$1')
}

/** True for a path Node cannot spawn directly on Windows. */
export const isBatchFile = (cmd, platform = process.platform) => platform === 'win32' && /\.(cmd|bat)$/i.test(String(cmd ?? ''))

/**
 * `{ file, args, options }` for child_process.spawn. `options` holds only what
 * the plan needs (merge it over your own options).
 */
export function spawnPlan(cmd, args = [], { platform = process.platform, comspec = process.env.ComSpec } = {}) {
  if (!isBatchFile(cmd, platform)) return { file: cmd, args: [...args], options: {} }
  const line = [escapeCommand(String(cmd).replace(/\//g, '\\')), ...args.map(escapeArgument)].join(' ')
  return {
    file: comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  }
}
