import threading
import time

from jobs import JobRegistry


def _wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_a_finished_job_reports_done():
    jobs = JobRegistry()

    def work(job):
        job.progress = 1.0

    job_id = jobs.start(work)
    assert _wait_until(lambda: jobs.snapshot(job_id)["state"] == "done")
    assert jobs.snapshot(job_id)["progress"] == 1.0


def test_progress_is_visible_while_the_job_is_still_running():
    release = threading.Event()
    jobs = JobRegistry()

    def work(job):
        job.progress = 0.5
        release.wait(5)

    job_id = jobs.start(work)
    assert _wait_until(lambda: jobs.snapshot(job_id)["progress"] == 0.5)
    # The whole point: this is readable BEFORE the work finishes.
    assert jobs.snapshot(job_id)["state"] == "running"
    release.set()


def test_a_raising_job_reports_error_with_its_message():
    jobs = JobRegistry()

    def work(job):
        raise RuntimeError("no engine for 'xx'")

    job_id = jobs.start(work)
    assert _wait_until(lambda: jobs.snapshot(job_id)["state"] == "error")
    assert "xx" in jobs.snapshot(job_id)["message"]


def test_cancelling_sets_the_flag_the_work_polls():
    jobs = JobRegistry()
    saw_cancel = threading.Event()

    def work(job):
        for _ in range(500):
            if job.cancel.is_set():
                saw_cancel.set()
                return
            time.sleep(0.01)

    job_id = jobs.start(work)
    assert _wait_until(lambda: jobs.snapshot(job_id)["state"] == "running")
    assert jobs.cancel(job_id)
    assert saw_cancel.wait(5)
    assert _wait_until(lambda: jobs.snapshot(job_id)["state"] == "cancelled")


def test_cancelling_an_unknown_job_reports_false():
    assert JobRegistry().cancel("nope") is False


def test_an_unknown_job_has_no_snapshot():
    assert JobRegistry().snapshot("nope") is None


def test_finished_jobs_are_pruned_so_the_registry_stays_bounded():
    jobs = JobRegistry()
    ids = []
    for _ in range(JobRegistry.MAX_FINISHED + 5):
        job_id = jobs.start(lambda job: None)
        ids.append(job_id)
        assert _wait_until(lambda: jobs.snapshot(job_id) is None
                           or jobs.snapshot(job_id)["state"] == "done")
    live = [i for i in ids if jobs.snapshot(i) is not None]
    assert len(live) <= JobRegistry.MAX_FINISHED + 1
    # The most recent job always survives.
    assert jobs.snapshot(ids[-1]) is not None
