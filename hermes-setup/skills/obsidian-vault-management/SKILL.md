---
name: obsidian-vault-management
description: Use when managing Obsidian vaults. Architect hubs.
---

# Obsidian Vault Management Skill

Use this skill when setting up, restructuring, or maintaining an Obsidian vault intended for managing multiple related software projects or an agent ecosystem.

## Workflow: Multi-Project Vault Setup

1. **Register the Vault**: Update `obsidian.json` in the user's app data directory to include the new root path. Remove any stale entries for old paths.
2. **Configure App Settings**: Write `.obsidian/app.json` to set `userIgnoreFilters` (e.g., `node_modules`, `.git`, `dist`, `cache`) and define `Vault/` as the default location for new files and attachments.
3. **Configure Graph Settings**: Write `.obsidian/graph.json` with `colorGroups` to visually differentiate projects in the graph view.
4. **Initialize Structure**:
   - Create a `Vault/` directory.
   - Create `Vault/Home.md` as the central dashboard.
   - Create `Vault/Graph/` for exported knowledge graphs.
   - Create one hub note per project in `Vault/[ProjectName].md`.
5. **Establish Maintenance Rules**: Instruct project lead agents to maintain their respective hub notes (Status, Next, Log).

## Hub Note Standard

Every project hub note must include:
- **Type**: `type: project-hub` in frontmatter.
- **Lead Agent**: The name of the agent responsible for the project.
- **Key Documents**: Wikilinks to major project files (e.g., `[[ARCHITECTURE]]`, `[[CLAUDE]]`).
- **Status**: Current high-level state (max 3 lines).
- **Next**: Most important upcoming tasks.
- **Log**: A bulleted list of dated, substantial changes (e.g., `- YYYY-MM-DD: Updated X because Y`, written with its path from the vault root).

## Pitfalls

- **Sensitive Data**: Never put keys, passwords, customer data, or pricing in the vault. Link to the source file instead.
- **Visibility**: Files in dot-folders (like `.git` or `.claude`) are invisible in Obsidian. Ensure important docs are in the main project tree.
- **Stale Links**: Moving projects breaks existing Obsidian registry entries. Always verify the vault is correctly registered in `obsidian.json` after a migration.
- **Log Bloat**: Avoid recording trivial tasks in the Log. Use it for substantial state changes only.

## References

- [templates/hub-note-template.md](templates/hub-note-template.md) - Standard structure for project hub notes.
- [templates/app-config-template.json](templates/app-config-template.json) - Recommended `.obsidian/app.json` configuration.
- [templates/graph-config-template.json](templates/graph-config-template.json) - Recommended `.obsidian/graph.json` color group setup.
