"""Export the real app's schema using the same engine/Windows mocks as unit tests."""
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes import load_service

with tempfile.TemporaryDirectory() as home:
    service, _, stack, _, _ = load_service(home)
    with stack:
        destination = Path(__file__).resolve().parents[1] / "openapi.json"
        destination.write_text(json.dumps(service.app.openapi(), indent=2) + "\n", encoding="utf-8")
