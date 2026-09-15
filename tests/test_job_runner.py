import hashlib
import json
import os
import subprocess
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from pathlib import Path

from control_store import ControlStore
from job_runner import ActiveJob, JobRunner, classify_process_outcome, stopped_job_action
from runtime_config import DEFAULT_EVENT_KEY, DEFAULT_EVENT_NAME


class JobRunnerConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / "job"
        self.directory.mkdir()
        self.runner = JobRunner(ControlStore(Path(self.temp.name) / "control.db"))
        self.job = {
            "id": "job_test", "workspace_id": "ws_test", "event_id": DEFAULT_EVENT_KEY,
            "event_name": DEFAULT_EVENT_NAME, "event_key": DEFAULT_EVENT_KEY,
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_pi_command_is_explicit_anthropic_and_never_contains_key(self):
        command = self.runner.pi_command(self.job, self.directory, {}, "job prompt")
        self.assertEqual(command[command.index("--provider") + 1], "anthropic")
        self.assertEqual(command[command.index("--model") + 1], "claude-sonnet-4-6")
        self.assertNotIn("--api-key", command)
        self.assertNotIn("ANTHROPIC_API_KEY", " ".join(command))
        self.assertIn("--no-builtin-tools", command)
        extension = command[command.index("--extension") + 1]
        self.assertTrue(extension.endswith("extensions/cvent-job-tools.ts"))
        tools = set(command[command.index("--tools") + 1].split(","))
        self.assertIn("read", tools)
        self.assertIn("bash", tools)
        self.assertEqual(tools, {
            "read", "bash",
            "cvent_prepare_rr", "cvent_expectations", "cvent_plan", "cvent_job_read",
            "cvent_job_update", "cvent_record_domain", "cvent_verify_domain", "cvent_browser", "cvent_section_state", "cvent_execute_section", "cvent_login_handoff",
            "cvent_snapshot_chunk", "cvent_finish",
        })
        self.assertTrue(command[command.index("--skill") + 1].endswith("skills/ego-browser/SKILL.md"))
        self.assertEqual(command[command.index("--mode") + 1], "json")
        self.assertEqual(command[-1], "job prompt")

    def test_simple_launcher_has_only_browser_and_lifecycle_tools(self):
        with patch.dict(os.environ, {'CVENT_EXECUTION_MODE':'simple'}):
            command=self.runner.pi_command(self.job,self.directory,{},'mission')
            prompt=self.runner.render_prompt(self.job,self.directory,{})
            environment=self.runner.environment(self.job,'lease',1)
        self.assertEqual(set(command[command.index('--tools')+1].split(',')), {'read','bash','cvent_open_event','cvent_login_handoff','cvent_job_update','cvent_finish'})
        self.assertIn('You own the whole mission',prompt)
        self.assertNotIn('ROUND_PLANNING_ERROR',prompt)
        self.assertEqual(environment['CVENT_EXECUTION_MODE'],'simple')

    def test_simple_optional_compiler_failure_preserves_original_evidence(self):
        original=self.directory/'input.inspection.json';original.write_text('{"sheets":[{"name":"Unrecognized RR layout"}]}')
        (self.directory/'expected-domains.json').write_text('{"stale":true}')
        def run(command, **kwargs):
            return subprocess.CompletedProcess(command, 0 if command[1].endswith('inspect_rr.py') else 1, '', 'Unknown compiler layout')
        with patch.dict(os.environ, {'CVENT_EXECUTION_MODE':'simple'}), patch('job_runner.job_dir',return_value=self.directory), patch.object(subprocess,'run',side_effect=run):
            self.assertEqual(self.runner.prepare_rr(self.job,1),{})
        self.assertTrue(original.exists())
        self.assertFalse((self.directory/'expected-domains.json').exists())
        archived = list((self.directory/'compiler-diagnostics').glob('*/expected-domains.json'))
        self.assertEqual(len(archived), 1)
        self.assertEqual(json.loads(archived[0].read_text()), {'stale': True})
        performance = json.loads((self.directory/'preflight-performance.json').read_text())
        self.assertEqual(performance['source'], 'original_workbook')

    def test_simple_compiler_timeout_or_unavailable_uses_original_without_browser(self):
        for error in (subprocess.TimeoutExpired('compiler', 180), FileNotFoundError('compiler')):
            with self.subTest(error=type(error).__name__):
                commands = []
                def run(command, **kwargs):
                    commands.append(command)
                    if command[1].endswith('inspect_rr.py'):
                        return subprocess.CompletedProcess(command, 0, '', '')
                    raise error
                with patch.dict(os.environ, {'CVENT_EXECUTION_MODE':'simple'}), patch('job_runner.job_dir',return_value=self.directory), patch.object(subprocess,'run',side_effect=run):
                    self.assertEqual(self.runner.prepare_rr(self.job,1),{})
                self.assertEqual(len(commands), 2)
                self.assertIn(type(error).__name__, json.loads((self.directory/'preflight-performance.json').read_text())['compilerWarning'])

    def test_original_workbook_read_failure_still_stops_before_browser(self):
        for result in (subprocess.TimeoutExpired('inspection',180), subprocess.CompletedProcess([],1,'','Corrupt Excel')):
            with self.subTest(result=str(result)), patch.dict(os.environ, {'CVENT_EXECUTION_MODE':'simple'}), patch('job_runner.job_dir',return_value=self.directory):
                with patch.object(subprocess,'run',side_effect=result if isinstance(result,Exception) else None,return_value=result) as run:
                    with self.assertRaisesRegex(RuntimeError, 'RR preflight failed'):
                        self.runner.prepare_rr(self.job,1)
                    self.assertEqual(run.call_count,1)

    def test_simple_wrong_event_or_malformed_compiler_hints_are_archived_not_used(self):
        (self.directory/'input.xlsx').write_bytes(b'original workbook')
        for hints in ([], {'rr':{},'target':{'eventId':'wrong-event'}}):
            with self.subTest(hints=hints):
                (self.directory/'expected-domains.json').write_text(json.dumps(hints))
                (self.directory/'rr-validation.json').write_text(json.dumps({'rrSha256':'wrong'}))
                (self.directory/'configuration-plan.json').write_text(json.dumps({'target':{'eventId':'wrong-event'}}))
                result=subprocess.CompletedProcess([],0,'','')
                with patch.dict(os.environ, {'CVENT_EXECUTION_MODE':'simple'}), patch('job_runner.job_dir',return_value=self.directory), patch.object(subprocess,'run',return_value=result):
                    self.assertEqual(self.runner.prepare_rr(self.job,1),{})
                self.assertFalse((self.directory/'expected-domains.json').exists())
                self.assertFalse((self.directory/'rr-validation.json').exists())
        self.assertEqual(len(list((self.directory/'compiler-diagnostics').glob('*/expected-domains.json'))),2)

    def test_legacy_mode_does_not_fall_back_on_compiler_timeout(self):
        result=subprocess.CompletedProcess([],0,'','')
        with patch.dict(os.environ, {'CVENT_EXECUTION_MODE':'legacy'}), patch('job_runner.job_dir',return_value=self.directory), patch.object(subprocess,'run',side_effect=[result,subprocess.TimeoutExpired('compiler',180)]):
            with self.assertRaisesRegex(RuntimeError, 'rr_extraction'):
                self.runner.prepare_rr(self.job,1)

    def test_worker_profiles_persist_per_workspace_and_never_share_between_slots(self):
        first = self.runner.environment(self.job, "lease-token", 1)
        same = self.runner.environment(dict(self.job, id="job_next"), "lease-next", 1)
        second = self.runner.environment(self.job, "lease-token", 2)
        self.assertEqual(first["CVENT_BROWSER_PROFILE_DIR"], same["CVENT_BROWSER_PROFILE_DIR"])
        self.assertNotEqual(first["CVENT_BROWSER_PROFILE_DIR"], second["CVENT_BROWSER_PROFILE_DIR"])
        self.assertIn("browser-profiles/slot-1/chromium-profile", first["CVENT_BROWSER_PROFILE_DIR"])
        self.assertIn("browser-profiles/slot-2/chromium-profile", second["CVENT_BROWSER_PROFILE_DIR"])

    def test_pi_environment_excludes_application_auth_secrets(self):
        with patch.dict(os.environ, {
            "ANTHROPIC_API_KEY": "provider-key",
            "ENTRA_CLIENT_SECRET": "entra-secret",
            "CVENT_SESSION_SECRET": "session-secret",
            "AZURE_CLIENT_SECRET": "azure-secret",
        }):
            environment = self.runner.pi_environment(self.job, "lease-token", 1)
        self.assertEqual(environment["ANTHROPIC_API_KEY"], "provider-key")
        self.assertEqual(environment["CVENT_LEASE_TOKEN"], "lease-token")
        self.assertNotIn("ENTRA_CLIENT_SECRET", environment)
        self.assertNotIn("CVENT_SESSION_SECRET", environment)
        self.assertNotIn("AZURE_CLIENT_SECRET", environment)

    def test_deterministic_rr_preflight_environment_has_no_provider_or_app_secrets(self):
        with patch.dict(os.environ, {
            "ANTHROPIC_API_KEY": "provider-key",
            "CVENT_LEASE_TOKEN": "lease-token",
            "ENTRA_CLIENT_SECRET": "entra-secret",
            "CVENT_SESSION_SECRET": "session-secret",
        }):
            environment = self.runner.prepare_environment(self.job, 1)
        self.assertEqual(environment["CVENT_JOB_ID"], self.job["id"])
        self.assertEqual(environment["CVENT_WORKER_SLOT"], "1")
        self.assertFalse(set(environment) & {
            "ANTHROPIC_API_KEY", "CVENT_LEASE_TOKEN", "ENTRA_CLIENT_SECRET", "CVENT_SESSION_SECRET",
        })

    def test_deterministic_rr_preflight_runs_before_agent_with_matching_evidence(self):
        workbook = self.directory / "input.xlsx"
        workbook.write_bytes(b"test-workbook")
        expected = {
            "rr": {"sha256": hashlib.sha256(workbook.read_bytes()).hexdigest(), "authority": "uploaded_rr"},
            "target": {"eventId": self.job["event_id"], "eventKey": self.job["event_key"], "name": self.job["event_name"]},
            "counts": {"applicableFields": 1},
        }
        commands = []

        def run(command, **kwargs):
            commands.append(command)
            if command[1].endswith("rr_compiler.py"):
                (self.directory / "expected-domains.json").write_text(json.dumps(expected))
            if command[1].endswith("rr_validator.py"):
                rr_hash = expected["rr"]["sha256"]
                (self.directory / "rr-validation.json").write_text(json.dumps({"rrSha256": rr_hash, "counts": {"VERIFIED": 1}}))
                (self.directory / "configuration-plan.json").write_text(json.dumps({"rrSha256": rr_hash, "target": expected["target"]}))
            return subprocess.CompletedProcess(command, 0, "{}", "")

        with patch("job_runner.job_dir", return_value=self.directory), \
             patch.object(self.runner, "prepare_environment", return_value={"PATH": os.environ.get("PATH", "")}), \
             patch.object(subprocess, "run", side_effect=run):
            result = self.runner.prepare_rr(self.job, 1)
        self.assertEqual(result, expected)
        self.assertTrue(commands[0][1].endswith("inspect_rr.py"))
        self.assertTrue(commands[1][1].endswith("rr_compiler.py"))
        self.assertTrue(commands[2][1].endswith("rr_validator.py"))
        performance = json.loads((self.directory / "preflight-performance.json").read_text())
        self.assertEqual([item["stage"] for item in performance["stages"]], ["rr_load_inspection", "rr_extraction", "rr_validation_and_planning"])

    def test_provider_probe_runs_without_application_secrets_and_fails_closed(self):
        completed = subprocess.CompletedProcess(["python"], 1, '{"ok":false,"classification":"credit_unavailable"}\n', "")
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "approved-key", "ENTRA_CLIENT_SECRET": "never-pass"}), \
             patch.object(subprocess, "run", return_value=completed) as run:
            with self.assertRaisesRegex(RuntimeError, "credit_unavailable"):
                self.runner.verify_provider_access(self.directory)
        environment = run.call_args.kwargs["env"]
        self.assertEqual(environment["ANTHROPIC_API_KEY"], "approved-key")
        self.assertNotIn("ENTRA_CLIENT_SECRET", environment)
        artifact = json.loads((self.directory / "provider-probe.json").read_text())
        self.assertFalse(artifact["ok"])

    def test_pi_config_bounds_429_retry_behavior(self):
        self.runner._write_pi_settings(self.directory)
        settings = json.loads((self.directory / "pi-config" / "settings.json").read_text())
        self.assertEqual(settings["retry"]["maxRetries"], 3)
        self.assertEqual(settings["retry"]["baseDelayMs"], 2000)
        self.assertEqual(settings["retry"]["provider"]["maxRetries"], 0)
        self.assertEqual(settings["retry"]["provider"]["maxRetryDelayMs"], 60000)

    def test_provider_credit_failure_is_reported_without_exposing_secrets(self):
        (self.directory / "pi-output.log").write_text(
            'invalid_request_error: Your credit balance is too low to access the Anthropic API\n'
        )
        self.assertEqual(
            self.runner._provider_failure(self.directory),
            "Anthropic API credit balance is too low",
        )

    def test_incomplete_runtime_failure_is_not_item_review(self):
        self.assertEqual(
            classify_process_outcome(0, "INCOMPLETE", "running", False, False, "tools missing")[0],
            "failed_prewrite",
        )
        self.assertEqual(classify_process_outcome(0, "REVIEW_REQUIRED", "running", True, False, None),
                         ("review_required", False, None))
        self.assertEqual(classify_process_outcome(0, "DRAFT_COMPLETE", "running", True, True, None)[0],
                         "failed_uncertain")
        self.assertEqual(
            classify_process_outcome(1, "INCOMPLETE", "running", False, False, None)[0],
            "failed_prewrite",
        )

    def test_login_handoff_exit_is_not_completion_and_preserves_uncertainty(self):
        self.assertEqual(classify_process_outcome(0, "", "login_required", False, False, None),
                         ("login_required", False, None))
        self.assertEqual(classify_process_outcome(0, "", "login_required", True, False, None),
                         ("login_required", False, None))
        self.assertEqual(classify_process_outcome(0, "", "login_required", True, True, None)[0:2],
                         ("failed_uncertain", True))
        action = stopped_job_action("login_required", None)
        self.assertIn("worker released", action)
        self.assertIn("Continue this job", action)
        self.assertEqual(stopped_job_action("failed_uncertain", "Unresolved mutation"), "Unresolved mutation")
        self.assertEqual(stopped_job_action("completed", None), "Draft build complete")

    def test_login_timeout_monitor_releases_worker_and_event_for_next_job(self):
        store = self.runner.store
        user = store.ensure_user("local-test", "test@example.test", "Test", False)
        event = SimpleNamespace(event_id=DEFAULT_EVENT_KEY, event_key=DEFAULT_EVENT_KEY, name=DEFAULT_EVENT_NAME)
        job = store.create_job(user, event, "rr.xlsx", preferred_slot=1)
        lease = store.reserve_now(job["id"], user["subject"])
        process = Mock(pid=987654)
        process.wait.return_value = 0
        active = ActiveJob(job["id"], lease["token"], 1, threading.Event(), process)
        self.runner._active[job["id"]] = active
        (self.directory / "state.json").write_text(json.dumps({"status": "login_required", "pending": ["Untouched RR work"]}))
        (self.directory / "browser-gate.json").write_text(json.dumps({"ownership": "USER", "desiredOwnership": "USER"}))
        with patch("job_runner.job_dir", return_value=self.directory), \
             patch.object(self.runner, "steel_command") as steel, \
             patch.object(self.runner, "prepare_environment", return_value={}), \
             patch("job_runner.subprocess.run"), patch("job_runner.write_telemetry_report"):
            self.runner._monitor(job, active)
        steel.assert_called_once_with(job, lease["token"], 1, "release", timeout=60)
        self.assertEqual(store.get_job(job["id"])["state"], "login_required")
        self.assertFalse(store.get_job(job["id"])["uncertain"])
        self.assertIsNone(self.runner.active(job["id"]))
        self.assertTrue(active.stop_heartbeat.is_set())
        state = json.loads((self.directory / "state.json").read_text())
        self.assertIsNone(state["pi_pid"])
        self.assertEqual(state["pending"], ["Untouched RR work"])
        self.assertIn("worker released", state["current_action"])
        # No force-unlock: the actual monitor/ControlStore finish path releases
        # both leases. The stale USER gate alone must not reserve the worker.
        next_job = store.create_job(user, event, "next.xlsx", preferred_slot=1)
        self.assertEqual(store.reserve_now(next_job["id"], user["subject"])["slot_id"], 1)

    def test_provider_failure_after_conclusive_write_readback_is_recoverable(self):
        outcome = classify_process_outcome(1, "", "running", True, False, "Anthropic API credit balance is too low")
        self.assertEqual(outcome[0], "failed_recoverable")
        self.assertFalse(outcome[1])
        self.assertIn("conclusively read back", outcome[2])
        unresolved = classify_process_outcome(1, "", "running", True, True, "provider failed")
        self.assertEqual(unresolved[0], "failed_uncertain")
        self.assertTrue(unresolved[1])

    def test_recoverable_retry_preserves_completed_domain_checkpoint(self):
        job = {**self.job, "state": "failed_recoverable", "uncertain": 0, "original_filename": "rr.xlsx"}
        (self.directory / "state.json").write_text(json.dumps({
            "status": "failed_recoverable", "current_stage": "optional_items", "resume_requested": True,
            "pi_session": "old-session", "completed": ["event_settings", "registration_types", "admission_items"],
            "pending": ["optional_items", "pricing"],
        }))
        optional_evidence = self.directory / "optional-items-inventory.json"
        optional_evidence.write_text(json.dumps({"categories": 8, "items": 35, "proof": "live"}))
        with patch.object(self.runner.store, "get_job", return_value=job), \
             patch("job_runner.job_dir", return_value=self.directory), \
             patch("job_runner.mutation_outcome", return_value={"unresolved": False}), \
             patch.object(self.runner, "start") as start:
            self.runner.retry_recoverable(job["id"], "operator")
        state = json.loads((self.directory / "state.json").read_text())
        self.assertEqual(state["completed"], ["event_settings", "registration_types", "admission_items"])
        self.assertEqual(state["pending"][0], "optional_items")
        self.assertIsNone(state["pi_session"])
        self.assertEqual(json.loads(optional_evidence.read_text())["items"], 35)
        start.assert_called_once_with(job["id"], "operator")

    def test_failed_prewrite_retry_uses_a_fresh_session_only_without_write_evidence(self):
        job = {**self.job, "state": "failed_prewrite", "uncertain": 0, "original_filename": "rr.xlsx"}
        (self.directory / "state.json").write_text(json.dumps({
            "status": "failed_prewrite", "resume_requested": True,
            "pi_session": "old-session", "completed": ["event_basics"],
        }))
        with patch.object(self.runner.store, "get_job", return_value=job), \
             patch("job_runner.job_dir", return_value=self.directory), \
             patch.object(self.runner, "start") as start:
            self.runner.retry_prewrite(job["id"], "operator")
        state = json.loads((self.directory / "state.json").read_text())
        self.assertFalse(state["resume_requested"])
        self.assertIsNone(state["pi_session"])
        self.assertEqual(state["completed"], [])
        start.assert_called_once_with(job["id"], "operator")

        (self.directory / "scope-write-audit.jsonl").write_text("attempted\n")
        with patch.object(self.runner.store, "get_job", return_value=job), \
             patch("job_runner.job_dir", return_value=self.directory):
            with self.assertRaisesRegex(ValueError, "mutation evidence"):
                self.runner.retry_prewrite(job["id"], "operator")

    def test_prompt_has_job_paths_coverage_floor_and_no_unresolved_placeholders(self):
        (self.directory / "rr-validation.json").write_text(json.dumps({"items": [
            {"domain": "event_settings"}, {"domain": "event_settings"}, {"domain": "site_designer"},
        ]}))
        with patch.dict(os.environ, {"CVENT_EXECUTION_MODE": "simple"}):
            prompt = self.runner.render_prompt(self.job, self.directory, {})
        self.assertIn("`event_settings`: 2 RR evidence items", prompt)
        self.assertIn("`site_designer`: 1 RR evidence items", prompt)
        self.assertIn(str(self.directory.resolve()), prompt)
        self.assertIn(DEFAULT_EVENT_NAME, prompt)
        self.assertIn(DEFAULT_EVENT_KEY, prompt)
        self.assertIn("- None.", prompt)
        self.assertNotRegex(prompt, r"{{[A-Z0-9_]+}}")

    def test_event_replay_holds_are_bound_into_prompt_and_resumed_session(self):
        holds = self.directory.parent / "event-holds"
        holds.mkdir()
        (holds / f"{DEFAULT_EVENT_KEY}.json").write_text(json.dumps({
            "eventKey": DEFAULT_EVENT_KEY,
            "holds": [{"domain": "registration_types", "identityType": "code", "identity": "HELD-CODE",
                       "outcome": "MATCH_UNCERTAIN_HUMAN_REVIEW", "automaticReplayPermitted": False}],
        }))
        prompt = self.runner.render_prompt(self.job, self.directory, {})
        self.assertIn("`HELD-CODE`", prompt)
        copied = json.loads((self.directory / "replay-holds.json").read_text())
        self.assertEqual(copied["holds"][0]["identity"], "HELD-CODE")
        sessions = self.directory / "pi-sessions"
        sessions.mkdir()
        (sessions / "saved.jsonl").write_text("{}\n")
        command = self.runner.pi_command(self.job, self.directory, {"resume_requested": True}, prompt)
        self.assertIn("HELD-CODE", command[-1])
        self.assertIn("complete controlling job prompt", command[-1])


if __name__ == "__main__":
    unittest.main()
