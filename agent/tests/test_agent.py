import os, sys, tempfile, types, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tools
from agent import Agent


class ToolTests(unittest.TestCase):
    def test_calc(self):
        self.assertEqual(tools.run_tool("calculator", {"expression": "2*(3+4)"}), ("14", False))

    def test_calc_rejects_code(self):
        self.assertTrue(tools.run_tool("calculator", {"expression": "__import__('os')"})[1])

    def test_path_escape(self):
        self.assertTrue(tools.run_tool("read_file", {"path": "../../etc/passwd"})[1])


def blk(**k): return types.SimpleNamespace(**k)


class FakeClient:
    def __init__(self):
        self.n = 0
        self.messages = self
    def create(self, **kw):
        self.n += 1
        if self.n == 1:
            return blk(stop_reason="tool_use", content=[blk(
                type="tool_use", id="t1", name="calculator", input={"expression": "6*7"})])
        return blk(stop_reason="end_turn", content=[blk(type="text", text="42")])


class LoopTest(unittest.TestCase):
    def test_loop(self):
        a = Agent(FakeClient())
        self.assertEqual(a.ask("6*7؟"), "42")
        self.assertEqual(a.messages[2]["content"][0]["content"], "42")


if __name__ == "__main__":
    unittest.main()
