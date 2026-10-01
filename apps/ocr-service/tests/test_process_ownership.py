from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from process_ownership import ProcessHandle


class ProcessOwnershipTests(unittest.TestCase):
    def process(self, identity="birth"):
        process = object.__new__(ProcessHandle)
        process.handle, process.kernel = object(), Mock()
        process.identity = Mock(return_value=identity)
        return process

    def test_wrong_or_dead_identity_is_never_terminated(self):
        for identity in (None, "reused"):
            process = self.process(identity)
            process.stop("birth")
            process.kernel.TerminateProcess.assert_not_called()

    def test_stop_uses_same_open_handle_and_waits_for_death(self):
        process = self.process()
        process.kernel.WaitForSingleObject.return_value = 0
        process.stop("birth")
        process.kernel.TerminateProcess.assert_called_once_with(process.handle, 124)
        process.kernel.WaitForSingleObject.assert_called_once_with(process.handle, 5000)

    def test_stop_never_treats_wait_timeout_as_death(self):
        process = self.process()
        process.kernel.WaitForSingleObject.return_value = 258
        with self.assertRaises(OSError):
            process.stop("birth")
