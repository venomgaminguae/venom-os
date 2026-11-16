---
name: deep-uninstallation-and-cleanup
description: Use when removing software traces. Clean up in stages.
---
# Deep Uninstallation and Cleanup
Use when a user requests to "remove all traces", "uninstall", or "clean up" a specific software, plugin, or configuration from the system.

## Procedure
1. **Discovery**: Map the target's footprint using `find`, `grep`, `ls -R`, `env`, and `echo $PATH`. Check specific config locations (`~/.config`, `~/.local`, `$LOCALAPPDATA`, `$APPDATA`) and program-specific directories (e.g., `.claude`, `.gemini`, `.cursor`, `.codex`).
2. **Categorization**: Group findings into:
   - **Files/Directories**: Logs, caches, binaries, and local data.
   - **Configuration Entries**: JSON, TOML, or YAML entries (especially MCP server definitions or plugin lists).
   - **Environment Variables**: `PATH` entries, shell profiles (`.bashrc`, `.zshrc`, etc.).
   - **Persistent State**: Databases, SQLite files, or application-specific state folders.
3. **Safety Planning**: Identify which removals are "reversible" (Recycle Bin) vs "irreversible" (`rm`). Prepare a read-modify-write plan for JSON/text configs.
4. **Staged Execution**:
   - **Stage 1 (Caches/Logs)**: Remove non-critical transient data first.
   - **Stage 2 (Configurations)**: Patch JSON/text configs using a read-modify-write pattern to preserve file integrity.
   - **Stage 3 (High-Stakes/Complex)**: Execute PowerShell commands for moving files to the Recycle Bin or modifying the user `PATH`. Split these into a distinct, prompt-driven step to avoid command timeouts or interactive hangs.
5. **Final Verification**: Run a broad `grep` and `find` search across the system and environment to ensure no residual mentions or paths remain.

## Pitfalls
- **Config Corruption**: When patching JSON/TOML/YAML configs, always use a read-modify-write pattern; overwriting with partial data or incomplete objects will corrupt the file for all other services.
- **Irreversible Loss**: On Windows, use PowerShell's `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteToRecycleBin` for non-trivial user data to allow for recovery if the cleanup overreaches.
- **Broken Environment**: Always probe and clean the user `PATH` environment variable; deleting binaries without cleaning the `PATH` leaves the system with broken command lookups and shell errors.
- **Command Blocking**: Split high-stakes, potentially interactive, or long-running removals into a discrete discovery phase followed by a single, clear user prompt to prevent terminal timeouts and ensure explicit consent.
