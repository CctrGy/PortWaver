import time
import tempfile
import unittest
import main as app_main
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import mock_open, patch
from unittest.mock import Mock

from main import SerialApi
from pathlib import Path


class SerialApiTests(unittest.TestCase):
    def test_packaged_defaults_are_seeded_outside_the_executable(self) -> None:
        with TemporaryDirectory() as resources, TemporaryDirectory() as output:
            packaged = Path(resources) / "data" / "PortWaver"
            packaged.mkdir(parents=True)
            (packaged / "language.json").write_text('{"app_title":"PortWaver"}', encoding="utf-8")
            data_dir = Path(output) / "data" / "PortWaver"
            with patch("main.ROOT", Path(output)), patch("main.DATA_DIR", data_dir), patch("main.PACKAGED_DATA_DIR", packaged), patch("main.PROFILE_DIR", data_dir / "profiles"):
                app_main.prepare_data_directory()
            self.assertEqual((data_dir / "language.json").read_text(encoding="utf-8"), '{"app_title":"PortWaver"}')
            self.assertTrue((data_dir / "profiles").is_dir())

    def test_main_starts_webview_with_program_icon(self) -> None:
        with patch("main.prepare_data_directory"), patch("main.resolve_window_options", return_value=(1200, 760, True)), patch("main.webview.create_window"), patch("main.webview.start") as start:
            app_main.main()
        start.assert_called_once_with(debug=False, icon=str(app_main.ICON_FILE))

    def test_emulated_loopback(self) -> None:
        api = SerialApi()
        config = {
            "mode": "emulate",
            "port": "VIRTUAL-COM1",
            "baudrate": 115200,
            "bytesize": 8,
            "parity": "N",
            "stopbits": 1,
            "vid": "FFFF",
            "pid": "0001",
        }
        self.assertTrue(api.connect_serial(config)["ok"])
        self.assertTrue(api.send_serial('{"one":1,"two":2}')["ok"])
        time.sleep(0.2)
        messages = api.poll_serial()["messages"]
        api.disconnect_serial()
        self.assertEqual(messages[0]["text"], '{"one":1,"two":2}')

    def test_custom_log_path_and_name(self) -> None:
        api = SerialApi()
        file_mock = mock_open()
        with patch("pathlib.Path.mkdir"), patch("pathlib.Path.open", file_mock):
            result = api.set_logging(True, r"C:\SerialLogs", "capture_{date}_{time}")
            api._queue_message(b"test")
            api.set_logging(False)
        self.assertTrue(result["ok"])
        self.assertTrue(result["path"].endswith(".txt"))
        self.assertTrue(file_mock().write.called)

    def test_second_connection_is_rejected_until_disconnect(self) -> None:
        api = SerialApi()
        config = {"mode": "emulate", "port": "VIRTUAL-COM1", "baudrate": 115200}
        self.assertTrue(api.connect_serial(config)["ok"])
        first_reader = api.reader
        self.assertFalse(api.connect_serial(config)["ok"])
        self.assertIs(api.reader, first_reader)
        api.disconnect_serial()
        self.assertFalse(first_reader.is_alive())
        self.assertTrue(api.connect_serial(config)["ok"])
        api.disconnect_serial()

    def test_other_instance_cannot_claim_same_port_but_can_claim_another(self) -> None:
        first = SerialApi()
        second = SerialApi()
        with TemporaryDirectory() as directory:
            with patch("main.PORT_LOCK_DIR", Path(directory)):
                self.assertTrue(first.connect_serial({"mode": "emulate", "port": "VIRTUAL-A"})["ok"])
                self.assertFalse(second.connect_serial({"mode": "emulate", "port": "VIRTUAL-A"})["ok"])
                self.assertTrue(second.connect_serial({"mode": "emulate", "port": "VIRTUAL-B"})["ok"])
                first.disconnect_serial()
                second.disconnect_serial()

    def test_frameless_window_resize_uses_opposite_anchor(self) -> None:
        api = SerialApi(resizable=True)
        window = Mock()
        with patch("main.webview.windows", [window]):
            result = api.resize_window(1200, 760, "nw")
        self.assertTrue(result["ok"])
        window.resize.assert_called_once()
        self.assertEqual(window.resize.call_args.args[:2], (1200, 760))

        fixed_api = SerialApi(resizable=False)
        self.assertFalse(fixed_api.resize_window(1200, 760, "se")["ok"])

    def test_line_endings_flow_control_and_emulated_signals(self) -> None:
        api = SerialApi()
        config = {"mode":"emulate","port":"SIGNAL-LOOP","baudrate":115200,"flowControl":"xonxoff","rts":False,"dtr":True,"cts":True,"dsr":False,"dcd":True,"ri":False}
        self.assertTrue(api.connect_serial(config)["ok"])
        self.assertTrue(api.send_serial("line", True, "ascii", "crlf")["ok"])
        time.sleep(0.2)
        messages = api.poll_serial()["messages"]
        self.assertEqual(messages[0]["text"], "line")
        self.assertEqual(messages[0]["ending"], "crlf")
        self.assertTrue(api.send_serial("partial", True, "ascii", "none")["ok"])
        time.sleep(0.2)
        self.assertEqual(api.poll_serial()["messages"][0]["text"], "partial")
        self.assertTrue(api.set_signal_state("cts", False)["ok"])
        signals = api.poll_serial()["signals"]
        self.assertFalse(signals["cts"])
        self.assertTrue(api.send_break(0.05)["ok"])
        api.disconnect_serial()

    def test_profile_round_trip_uses_uservsp_extension(self) -> None:
        api = SerialApi()
        with tempfile.TemporaryDirectory() as directory, patch("main.PROFILE_DIR", Path(directory)):
            saved = api.save_profile("Bench ESP32", {"serial":{"baudrate":115200}})
            self.assertTrue(saved["ok"])
            self.assertTrue(saved["file"].endswith(".UserVSP"))
            profiles = api.list_profiles()
            loaded = api.load_profile(profiles[0]["file"])
            self.assertEqual(loaded["settings"]["serial"]["baudrate"], 115200)
            self.assertTrue(api.delete_profile(profiles[0]["file"])["ok"])

    def test_text_file_picker_preserves_empty_lines(self) -> None:
        api = SerialApi()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sequence.txt"
            path.write_text("first\n\nthird\n", encoding="utf-8")
            window = Mock()
            window.create_file_dialog.return_value = (str(path),)
            with patch("main.webview.windows", [window]):
                result = api.choose_text_file()
            self.assertTrue(result["ok"])
            self.assertEqual(result["lines"], ["first", "", "third"])


if __name__ == "__main__":
    unittest.main()
