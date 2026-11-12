"""Compile/validate native pipe protocol without accessing Keychain."""
import json
from pathlib import Path
import subprocess
import tempfile

source = Path(__file__).with_name("keychain-helper.swift")
with tempfile.TemporaryDirectory(prefix="paseo-keychain-validation-") as directory:
    binary = Path(directory) / "helper"
    subprocess.run(["swiftc", str(source), "-o", str(binary)], check=True)
    fixtures = [
        ({"operation": "write", "account": "fixture-only", "value": "not-a-real-token"}, "ok"),
        ({"operation": "read", "account": "fixture-only"}, "ok"),
        ({"operation": "delete", "account": "fixture-only"}, "ok"),
        ({"operation": "write", "account": "fixture-only", "value": ""}, "invalid_value"),
        ({"operation": "read", "account": "../escape"}, "invalid_request"),
        ({"operation": "read", "account": "fixture-only", "value": "secret"}, "invalid_value"),
    ]
    for request, status in fixtures:
        result = subprocess.run([str(binary), "--validate-only"], input=json.dumps(request), text=True, capture_output=True, timeout=5)
        assert json.loads(result.stdout) == {"status": status}
        assert result.returncode == (0 if status == "ok" else 1)
        assert not result.stderr
print("6 native validation cases passed; no Keychain operations; temporary binary removed")
