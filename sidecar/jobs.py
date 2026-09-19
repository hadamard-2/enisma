"""Background jobs the client polls, rather than long streaming responses.

Synthesis is a blocking 40-100 second call that reports through a callback.
A generator cannot yield from inside that callback, so a streaming route would
have to buffer every event until the work was already finished — no usable
progress, and nothing to interrupt. Running the work on a thread and exposing
it as a polled job fixes both, and decouples the work from one HTTP connection
so a long export can outlive the request that started it.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable
from uuid import uuid4

RUNNING = "running"
DONE = "done"
ERROR = "error"
CANCELLED = "cancelled"


@dataclass
class Job:
    id: str
    state: str = RUNNING
    progress: float = 0.0
    sample_rate: int | None = None
    duration_ms: int | None = None
    message: str | None = None
    # Work polls this and stops when it is set. Engines already accept a
    # progress callback that returns False to stop, so this bridges to that.
    cancel: threading.Event = field(default_factory=threading.Event)
    started: float = field(default_factory=time.monotonic)


Work = Callable[[Job], None]


class JobRegistry:
    """Thread-per-job, with a bounded memory of finished ones."""

    MAX_FINISHED = 16

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def start(self, work: Work) -> str:
        job = Job(id=uuid4().hex)
        with self._lock:
            self._prune_locked()
            self._jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, work), daemon=True).start()
        return job.id

    def _run(self, job: Job, work: Work) -> None:
        try:
            work(job)
        except Exception as exc:  # noqa: BLE001 - surfaced to the client verbatim
            with self._lock:
                job.message = str(exc)
                job.state = ERROR
            return
        # Work that returned early because it saw the cancel flag finished
        # cleanly; the flag is what distinguishes the two. Taken under the same
        # lock a snapshot reads, so a poller never sees a half-written terminal
        # state, and a cancel that lands mid-transition cannot turn a finished
        # job into a cancelled one (or vice versa).
        with self._lock:
            job.state = CANCELLED if job.cancel.is_set() else DONE

    def snapshot(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return {
                "state": job.state,
                "progress": job.progress,
                "sampleRate": job.sample_rate,
                "durationMs": job.duration_ms,
                "message": job.message,
            }

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            # Setting the flag under the lock keeps it ordered against the
            # terminal transition in _run: either the work is still running and
            # will observe the flag, or it has already settled on done/error and
            # that verdict stands.
            job.cancel.set()
            return True

    def _prune_locked(self) -> None:
        finished = [j for j in self._jobs.values() if j.state != RUNNING]
        if len(finished) <= self.MAX_FINISHED:
            return
        finished.sort(key=lambda j: j.started)
        for job in finished[: len(finished) - self.MAX_FINISHED]:
            self._jobs.pop(job.id, None)
