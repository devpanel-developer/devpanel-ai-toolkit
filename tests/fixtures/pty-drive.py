"""Runs a command in a pseudo-terminal and answers its prompts, to test hidden input.

    python3 -I pty-drive.py <command> [args...]

Answers "(input hidden): " prompts with $PTY_SECRET and "[y/N] " prompts with "y".
Prints everything the terminal displayed (the transcript) and exits with the child's code.
If hidden input works, the secret never appears in the transcript.
"""
import os
import pty
import select
import sys
import time

secret = os.environ["PTY_SECRET"].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

transcript = b""
answered = 0
deadline = time.time() + 60
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        transcript += chunk
    pending = transcript[answered:]
    if b"(input hidden): " in pending:
        answered = transcript.index(b"(input hidden): ", answered) + len(b"(input hidden): ")
        os.write(fd, secret + b"\r")
    elif b"[y/N] " in pending:
        answered = transcript.index(b"[y/N] ", answered) + len(b"[y/N] ")
        os.write(fd, b"y\r")

_, status = os.waitpid(pid, 0)
sys.stdout.write(transcript.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(status))
