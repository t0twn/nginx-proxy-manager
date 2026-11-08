"""Regression checks for Docker startup orchestration; no daemon required."""
import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "image_runner", pathlib.Path(__file__).resolve().parents[1] / "test-image.py"
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def result(stdout="", stderr="", code=0):
    return subprocess.CompletedProcess([], code, stdout=stdout, stderr=stderr)


class ImageRunnerTests(unittest.TestCase):
    def test_startup_mounts_and_cleans_both_required_anonymous_volumes(self):
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                def docker_response(*args, **kwargs):
                    if args[0] == "exec" and args[2] == "cat":
                        return result("resolver 127.0.0.1:5353 ipv6=off valid=1s;"
                                      if enabled else "resolver 127.0.0.11 valid=10s;")
                    return result()

                with patch.object(runner, "docker", side_effect=docker_response) as docker, \
                     patch.object(runner, "wait_for"):
                    runner.check_startup("test-image", enabled)
                start = docker.call_args_list[0].args
                mounts = [start[index + 1] for index, item in enumerate(start)
                          if item == "--volume"]
                self.assertCountEqual(mounts, ["/data", "/etc/letsencrypt"])
                name = start[start.index("--name") + 1]
                self.assertEqual(docker.call_args_list[-1].args,
                                 ("rm", "-f", "-v", name))

    def test_failed_startup_reports_logs_and_still_removes_anonymous_volumes(self):
        with patch.object(runner, "docker", return_value=result(stderr="prepare failed")) as docker, \
             patch.object(runner, "wait_for", side_effect=RuntimeError("stopped")), \
             contextlib.redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaisesRegex(RuntimeError, "stopped"):
                runner.check_startup("test-image", True)
        self.assertIn("prepare failed", stderr.getvalue())
        self.assertEqual(docker.call_args_list[-1].args[:3], ("rm", "-f", "-v"))

    def test_wait_fails_immediately_if_container_has_exited(self):
        state = {"Running": False, "Status": "exited", "ExitCode": 1, "Error": ""}
        with patch.object(runner, "docker", return_value=result(json.dumps(state))) as docker, \
             patch.object(runner.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, r"status=exited, exit=1"):
                runner.wait_for("test-container", "probe()")
        sleep.assert_not_called()
        self.assertEqual(docker.call_count, 1)
        self.assertEqual(docker.call_args.args[0], "inspect")

    def test_wait_succeeds_when_running_container_probe_passes(self):
        with patch.object(runner, "docker", side_effect=[
            result(json.dumps({"Running": True})), result()
        ]) as docker, patch.object(runner.time, "sleep") as sleep:
            runner.wait_for("test-container", "probe()")
        self.assertEqual(docker.call_count, 2)
        sleep.assert_not_called()

    def test_wait_rechecks_liveness_after_a_failed_probe(self):
        with patch.object(runner, "docker", side_effect=[
            result(json.dumps({"Running": True})),
            result(stderr="not ready", code=1),
            result(json.dumps({"Running": False, "Status": "exited", "ExitCode": 2})),
        ]) as docker, patch.object(runner.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "exit=2"):
                runner.wait_for("test-container", "probe()")
        self.assertEqual(docker.call_count, 3)
        sleep.assert_called_once_with(1)


if __name__ == "__main__":
    unittest.main()
