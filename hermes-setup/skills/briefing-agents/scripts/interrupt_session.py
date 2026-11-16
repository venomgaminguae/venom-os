"""Interrupt one live agent session inside the Hermes gateway (the same RPC the chat's /stop uses).

Agent runs started with `hermes -p <profile> chat -q ...` (and so every run sent through the
team connector) execute INSIDE the gateway process. Killing the client process, the connector or
the background terminal job does not stop them. This does.

Run with the gateway's own interpreter and the session's profile home:

  cd "$LOCALAPPDATA/hermes/hermes-agent"
  HERMES_HOME="$LOCALAPPDATA/hermes/profiles/<profile>" PYTHONPATH="$(pwd -W)" \
    venv/Scripts/python.exe "<this file>" <session_id>

Find the session id in the profile's logs/agent.log: the `conversation turn: session=local-...`
line whose msg= starts with the task text. Success shows as
`Turn ended: reason=interrupted_by_user` in that log.
"""
import asyncio
import sys

from hermes_cli.gateway_client import connect_gateway


async def main(sid):
    async with connect_gateway() as client:
        snap = await client.rpc("session.resume", session_id=sid)
        gen = snap.get("execution_generation", 0)
        result = await client.rpc("session.interrupt", session_id=sid, execution_generation=gen)
        print("interrupt sent; state was:", result.get("execution_state"))


asyncio.run(main(sys.argv[1]))
