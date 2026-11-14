"""Select HeartEcho's neighboring regression suites; plan by default, never publish."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SUITES = {
    "chat": ["reply-integrity", "refusal-fallback", "identity-continuity", "conversation-flow", "local-chat", "qq-catchup", "security"],
    "memory": ["life-continuity", "record-continuity", "next-version", "local-chat", "security"],
    "protocol": ["qq-recovery", "qq-catchup", "protocol-connection", "protocol-offline", "protocol-autoload", "multi-instance"],
    "storage": ["character-cards", "character-delete-writeback", "m1-character", "storage-location", "migration-export", "file-commit", "credential-isolation", "security"],
    "ui": ["chat-composer", "conversation-flow", "local-chat", "tooling", "security"],
    "release": ["installer-payload", "updates", "autostart", "panel-port-conflict", "credential-isolation", "privacy-audit"],
    "extensions": ["extensions", "conversation-flow", "security"],
}
RULES = [
    (r"^lib/(character-cards|ui-character-cards)\.mjs$", {"storage", "memory", "chat", "ui"}),
    (r"^lib/(chat|local-chat|local-channel|llm|tools)\.mjs$", {"chat", "memory"}),
    (r"^lib/(qq-recovery|recovery|onebot|protocol.*|health|instances)\.mjs$", {"protocol", "chat"}),
    (r"^lib/(archive-batch|cognition|body-state|character-evolution|continuity-.*|reflection-evidence|memory|extended-memory|hindsight-runtime|life|scope-lifecycle|scheduler)\.mjs$", {"memory", "chat"}),
    (r"^lib/(storage|db|paths|boot-env|config|file-commit|migration-export|log|chat-background)\.mjs$", {"storage", "memory", "chat"}),
    (r"^lib/(ui.*|api|next-api|local-chat|chat-background|log)\.mjs$", {"ui"}),
    (r"^lib/(updates|release-notes|version|desktop)\.mjs$", {"release", "ui"}),
    (r"^(installer/|tools/(build-.*|package-tb|payload-source-files\.json)|package(?:-lock)?\.json$)", {"release", "storage"}),
    (r"^(extensions/|lib/extensions\.mjs$)", {"extensions", "chat"}),
    (r"^index\.mjs$", set(SUITES)),
]


def command(args, root, **options):
    return subprocess.run(args, cwd=root, text=True, encoding="utf-8", errors="replace", shell=False,
                          **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}), **options)


def changed_files(root, base):
    # Comparing a tree to the worktree includes staged and unstaged tracked changes.
    paths = []
    for args in (["git", "diff", "--name-only", "-z", base, "--"],
                 ["git", "ls-files", "--others", "--exclude-standard", "-z"]):
        result = command(args, root, capture_output=True)
        if result.returncode:
            raise ValueError("Unable to read the requested Git baseline; specify --files or a valid --base.")
        paths.extend(filter(None, result.stdout.split("\0")))
    return sorted(set(paths))


def build_plan(root, files, requested=(), release=False):
    areas = set(requested)
    if release:
        areas.update(SUITES)
    reasons = {}
    fallback = []
    for raw in files:
        name = raw.replace("\\", "/").removeprefix("./")
        selected = set()
        for pattern, additions in RULES:
            if re.search(pattern, name):
                selected.update(additions)
        for area, suites in SUITES.items():
            if name in {f"tools/{suite}-test.mjs" for suite in suites}:
                selected.add(area)
        if not selected and (name.startswith(("lib/", "installer/")) or name == "index.mjs"):
            selected.update(SUITES)
            fallback.append(name)
        if selected:
            reasons[name] = sorted(selected)
            areas.update(selected)
    files_to_run = sorted({f"tools/{suite}-test.mjs" for area in areas for suite in SUITES[area]})
    commands = [["node", "--test", "--test-reporter=tap", *files_to_run]] if files_to_run else []
    # Real UI is required for changes spanning chat/memory consumers, not only template edits.
    browser = bool(areas & {"chat", "memory", "ui"})
    if browser:
        commands.append(["node", "--test", "--test-reporter=tap", "tools/local-chat-browser-test.mjs"])
    if release or any(re.search(r"^lib/(character-cards|ui-character-cards|config|api|scope-lifecycle)\.mjs$", name.replace("\\", "/")) for name in files):
        commands.append(["node", "--test", "--test-reporter=tap", "tools/character-cards-browser-test.mjs"])
    if release or any(re.search(r"^lib/(updates|release-notes|ui-update-guide)\.mjs$", name.replace("\\", "/")) for name in files):
        commands.append(["node", "--test", "--test-reporter=tap", "tools/update-startup-browser-test.mjs"])
    if release:
        commands.append(["node", "tools/selftest.mjs"])
    required = sorted({name for cmd in commands for name in cmd if name.startswith("tools/")})
    missing = [name for name in required if not (root / name).is_file()]
    return {"status": "planned" if commands else "not-applicable", "areas": sorted(areas), "reasons": reasons,
            "conservativeFallback": fallback, "commands": commands, "missing": missing,
            "ready": bool(commands) and not missing,
            "manualChecks": [
                "Review feature-mode, account/role/scope and async-boundary cases in references/regression.md.",
                "For release: test BOTH extracted payloads and actual current/previous installers; this runner does not certify packages.",
            ]}


def assess_test_output(text, exit_code):
    def count(label):
        found = re.findall(r"^#\s+" + label + r"\s+(\d+)\s*$", text, re.M)
        return int(found[-1]) if found else None
    totals = {key: count(key) for key in ["tests", "pass", "fail", "skipped", "cancelled"]}
    valid = (exit_code == 0 and (totals["tests"] or 0) > 0 and totals["fail"] == 0
             and totals["skipped"] == 0 and totals["cancelled"] == 0)
    return {"status": "passed" if valid else "incomplete-or-failed", "exitCode": exit_code, **totals}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--files", nargs="+")
    parser.add_argument("--base", default="HEAD")
    parser.add_argument("--area", action="append", choices=sorted(SUITES), default=[])
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        package = json.loads((root / "package.json").read_text(encoding="utf-8-sig"))
        if package.get("name") != "heartecho":
            raise ValueError("The root is not the HeartEcho project.")
        files = args.files if args.files is not None else ([] if args.area or args.release else changed_files(root, args.base))
        plan = build_plan(root, files, args.area, args.release)
        plan["version"] = package.get("version")
        print(json.dumps(plan, ensure_ascii=False, indent=2), flush=True)
        if not args.run:
            return 0
        if not plan["ready"]:
            raise ValueError("No runnable, complete plan. Resolve missing suites/baseline or choose --area; no tests were run.")
        node = shutil.which("node")
        if not node:
            raise ValueError("Node is unavailable.")
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("HEARTECHO_") and key not in {"NODE_OPTIONS", "NODE_TEST_CONTEXT"}}
        probe = command([node, "--input-type=module", "-e",
                         "if(Number(process.versions.node.split('.')[0])<24)process.exit(2);"
                         "const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(':memory:');"
                         "db.exec('create virtual table probe using fts5(content)');db.close();"],
                        root, env=env, capture_output=True)
        if probe.returncode:
            raise ValueError("Use a Node 24+ runtime with node:sqlite and FTS5; no project tests were run.")
        results = []
        for cmd in plan["commands"]:
            print("Running: " + " ".join(cmd), flush=True)
            result = command([node, *cmd[1:]], root, env=env, capture_output=True)
            if "--test" in cmd:
                checked = assess_test_output(result.stdout, result.returncode)
            else:
                matches = re.findall(r"心语自检：\s*(\d+)\s*/\s*(\d+)\s*通过", result.stdout)
                passed = bool(matches and int(matches[-1][0]) > 0 and matches[-1][0] == matches[-1][1] and result.returncode == 0)
                checked = {"status": "passed" if passed else "incomplete-or-failed", "exitCode": result.returncode}
            checked["command"] = cmd
            results.append(checked)
            print(json.dumps(checked, ensure_ascii=False), flush=True)
            if checked["status"] != "passed":
                # The listed suites use isolated fixtures; never dump the parent environment.
                print((result.stdout + result.stderr)[-10000:], file=sys.stderr)
                break
        report = {"version": package.get("version"), "areas": plan["areas"], "results": results,
                  "status": "passed" if len(results) == len(plan["commands"]) and all(r["status"] == "passed" for r in results) else "incomplete-or-failed",
                  "packageReleaseVerified": False}
        if args.report:
            destination = args.report.resolve()
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("x", encoding="utf-8") as stream:
                json.dump(report, stream, ensure_ascii=False, indent=2)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report["status"] == "passed" else 1
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
