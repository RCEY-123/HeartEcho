"""Behavior checks for selection and failure reporting; all fixtures are temporary."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("regression_guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTests(unittest.TestCase):
    def test_chat_change_includes_polling_memory_and_browser_neighbors(self):
        with tempfile.TemporaryDirectory() as root:
            plan = guard.build_plan(Path(root), ["lib/chat.mjs"])
            files = {part for cmd in plan["commands"] for part in cmd}
            for name in ["qq-catchup", "local-chat", "record-continuity", "security", "local-chat-browser"]:
                self.assertIn(f"tools/{name}-test.mjs", files)
            self.assertFalse(plan["ready"], "missing suites must not count as passing")

    def test_new_runtime_module_uses_conservative_plan(self):
        with tempfile.TemporaryDirectory() as root:
            plan = guard.build_plan(Path(root), ["lib/new-runtime.mjs"])
            self.assertEqual(set(plan["areas"]), set(guard.SUITES))
            self.assertIn("lib/new-runtime.mjs", plan["conservativeFallback"])

    def test_prose_only_is_not_turned_into_an_unrequested_full_test_run(self):
        with tempfile.TemporaryDirectory() as root:
            plan = guard.build_plan(Path(root), ["README.md", "角色卡/card.json"])
            self.assertEqual(plan["commands"], [])
            self.assertEqual(plan["status"], "not-applicable")

    def test_run_readiness_checks_actual_files_and_keeps_commands_as_arguments(self):
        with tempfile.TemporaryDirectory(prefix="Heart Echo ") as root:
            directory = Path(root)
            plan = guard.build_plan(directory, [], ["ui"])
            for name in plan["missing"]:
                file = directory / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("// synthetic fixture only", encoding="utf-8")
            ready = guard.build_plan(directory, [], ["ui"])
            self.assertTrue(ready["ready"])
            self.assertEqual(len(ready["commands"]), 2)
            self.assertNotIn("--with-llm", str(ready["commands"]))

    def test_zero_tests_skipped_browser_or_nonzero_exit_never_report_pass(self):
        good = "# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n"
        self.assertEqual(guard.assess_test_output(good, 0)["status"], "passed")
        for output, code in [(good.replace("tests 1", "tests 0"), 0),
                             (good.replace("skipped 0", "skipped 1"), 0),
                             (good, 1), ("", 0)]:
            self.assertNotEqual(guard.assess_test_output(output, code)["status"], "passed")


if __name__ == "__main__":
    unittest.main()
