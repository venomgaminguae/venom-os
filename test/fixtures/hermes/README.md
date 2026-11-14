# Hermes output fixtures

These were reconstructed from the Hermes source, not captured from a run.

Source: the installed `hermes_cli` package, `__release_date__ = "2026.9.24"`
(`hermes_cli/__init__.py`; `__version__` is read from an install stamp at run
time and `pyproject.toml` carries the placeholder `0.0.0`).

Files read:

- `hermes_cli/doctor.py` (`run_doctor`, `DOCTOR_CHECKS`, `_print_summary`, exit code)
- `hermes_cli/doctor_report.py` (row marks, `◆` section headings, `Finding`)
- `hermes_cli/doctor_config.py`, `doctor_platform.py`, `doctor_tools.py`,
  `doctor_state.py`, `doctor_connectivity.py` (row texts and summary lines)
- `hermes_cli/colors.py` (colour only when stdout is a terminal and `NO_COLOR` is unset)
- `hermes_cli/mcp_config.py` (`cmd_mcp_list`, `cmd_mcp_test`, `_lookup_server`, `_print_tools`)
- `tools/mcp_tool_errors.py` (`_format_connect_error`), `hermes_cli/main.py` (handler return = exit code)

What they show:

- `doctor-*.txt`: an excerpt of a full run. Rows of checks whose wording depends
  on the machine (SQLite, venv, Chromium, gateway, other provider probes) are
  left out; every row that is present uses the source's own wording and layout.
  The summary block is exact. Exit code: 0 when the summary says
  `All checks passed!`, otherwise 1 (`int(bool(issues or manual_issues))`).
- `mcp-list-*.txt`: exit 0. `mcp-test-ok.txt`: exit 0; `mcp-test-fail.txt`:
  exit 1; `mcp-test-not-found.txt`: exit 3 (server not in the config).
- Plain files are what a pipe gets (setup runs Hermes through a pipe, so it
  sees these). `*.ansi.txt` is the same output on a terminal, with colours.
- Line endings are LF here. Python's text-mode stdout on Windows normally
  writes CRLF; the parser and the tests accept both.

Made-up values: profile `venom`, paths under `C:/Users/you/`, `Python 3.11.9`,
timings, tool count. Regenerate by hand if Hermes changes this wording.
