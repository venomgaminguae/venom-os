# Adding an agent

An agent is a helper on your team that the voice assistant hands work to. Each
one runs on its own Hermes profile (its own settings, memory and job brief).

The team is a file you own: `venom.agents.json` in the repository folder.
Without it the four starter agents are used. Three commands change it:

| Command | What it does |
|---|---|
| `npm run add-agent` | Adds an agent, with its own Hermes profile and job brief |
| `npm run agents` | Shows the team and whether each agent answers |
| `npm run remove-agent` | Takes an agent off the team |

Run them in a terminal window in the repository folder, after `npm run setup`.
Restart Venom OS after a change: the app reads the team once, when it starts.

## Example: an Analyst

`npm run add-agent` asks three questions. Your answers are after each one.

```text
Add an agent to your Venom OS team.

What should the new agent be called? (one line, up to 40 characters) Analyst
What is its job? Describe it in your own words, in one paragraph (on one line): Reads reports and explains the numbers plainly. Never guesses.
Is it a general specialist, or tied to one project folder? 1) general specialist  2) one project folder  (default 1) 1
Its id is "analyst": the name of its Hermes profile, and how the team list and the activity log refer to it. It never changes.

Creating the Hermes profile analyst, copied from venom...
Wrote its job brief: ...\profiles\analyst\SOUL.md
Removed the team connector copied from venom (only the supervisor hands out work).

Analyst is on the team (saved in ...\venom.agents.json).

analyst was copied from venom, so any API key in the settings of venom carried over to it.
A subscription sign-in (ChatGPT, Claude account and similar) is stored per profile and is not copied. If venom uses one, sign in again with: hermes -p analyst model

Asking Analyst the one-line test question...
[pass] Analyst answered: READY

Restart Venom OS (close it and run `npm start`) so Analyst appears.
```

`venom` is the supervisor profile's name (the one you chose at setup). The
new profile is a copy of it. Its job brief (`SOUL.md`) is written from your
paragraph, using `hermes-setup/souls/agent.SOUL.md`. If you signed in with a
subscription rather than an API key, run the command it prints (`hermes -p
analyst model`) before you restart. If the name cannot become an id (for
example it starts with a digit), you are asked to type a short id yourself.

## Variant: a project lead

A project lead looks after the code in one folder and works inside it.
Answer `2` to the third question, then name the folder:

```text
Which folder? A full path, ~/..., or the name of a folder inside ...\Projects:
```

A plain name means a folder inside your projects folder (`PROJECTS_ROOT`, or
`Projects` in your home folder). The folder must exist; if not, you see
`There is no folder at ... Check the spelling, or create the folder first.`
Its job brief tells it never to push, publish or deploy without your go-ahead.

## Seeing and removing agents

`npm run agents` prints a table (ID, NAME, KIND, RUNS ON, PROFILE, ANSWERS)
and asks each agent the test question. `npm run agents -- --quick` skips the
question. Anything to fix is listed under `To fix:`.

`npm run remove-agent` lists the team and asks `Which agent do you want to
remove? Type its id or its name:`, then `Remove Analyst from the team?
(y/N)`. A second question asks before deleting its Hermes profile; the
default keeps it, with its memory and skills. `npm run remove-agent --
analyst` skips the first question. The last agent cannot be removed.

## The file itself

You can also edit `venom.agents.json` by hand (an example is in
`venom.agents.example.json`). Editing it does not create Hermes profiles:
use `npm run add-agent` for that.

```json
{
  "agents": [
    { "id": "analyst", "name": "Analyst", "kind": "specialist",
      "role": "Reads reports and explains the numbers plainly.", "pinned": true },
    { "id": "shop", "name": "Shop Lead", "kind": "project",
      "role": "Looks after the shop website code.",
      "folder": "shop-site", "profile": "shop-lead" }
  ]
}
```

- `id`: 2 to 32 lowercase letters, digits, `-` or `_`, starting with a
  letter. Never change it later: the activity log, the screen and the
  assistant all refer to the agent by it.
- `name`: what the screen shows and the assistant says (up to 40 characters).
- `kind`: `specialist`, `project` (a project lead) or `advisor` (a second
  opinion).
- `role`: one line that says what it is for; the supervisor picks agents by it.
- `folder`: only for a project lead, and the folder must exist. `profile`:
  only when the Hermes profile has another name than the id. `pinned`: `true`
  puts it first on the screen.
- Up to 12 agents are tested; more work, but the team dock may get crowded.

## If something goes wrong

- `The team list cannot be used:` followed by what is wrong, such as `is not
  valid JSON (...). Check for a missing comma, quote or bracket.` Fix the file
  as the message says, or rename it to go back to the starter team. The app
  does not start until the file is fixed.
- `its Hermes profile analyst is missing` (from `npm run agents`): run `npm
  run add-agent` and type the same name, or remove the agent.
- `[fail] Analyst did not answer` or `did not answer the test question`: the
  agent stays on the team. Sign it in with `hermes -p analyst model`, then
  check again with `npm run agents`.
- `Hermes was not found on this PC.`: run `npm run setup` first.
