"""مساعد AI agent: حلقة أدوات (tool loop) فوق Claude API."""
import os
import sys

import anthropic

from tools import TOOLS, run_tool

MODEL = os.environ.get("AGENT_MODEL", "claude-sonnet-5-5")
MAX_STEPS = 12
SYSTEM = ("أنت مساعد شخصي ذكي. رد بنفس لغة المستخدم (غالبًا العربية). "
          "استخدم الأدوات عند الحاجة، واحفظ المعلومات المهمة عن المستخدم بـ save_note. "
          "كن مختصرًا ودقيقًا.")


class Agent:
    def __init__(self, client=None):
        self.client = client or anthropic.Anthropic()
        self.messages = []

    def ask(self, text: str) -> str:
        self.messages.append({"role": "user", "content": text})
        for _ in range(MAX_STEPS):
            r = self.client.messages.create(
                model=MODEL, max_tokens=2048, system=SYSTEM,
                tools=TOOLS, messages=self.messages)
            self.messages.append({"role": "assistant", "content": r.content})
            if r.stop_reason != "tool_use":
                return "".join(b.text for b in r.content if b.type == "text")
            results = []
            for b in r.content:
                if b.type == "tool_use":
                    out, err = run_tool(b.name, b.input)
                    print(f"  [أداة] {b.name}({b.input})", file=sys.stderr)
                    results.append({"type": "tool_result", "tool_use_id": b.id,
                                    "content": out, "is_error": err})
            self.messages.append({"role": "user", "content": results})
        return "وصلت للحد الأقصى من الخطوات."


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("اضبط ANTHROPIC_API_KEY أولًا.")
    agent = Agent()
    print("المساعد جاهز. اكتب 'خروج' للإنهاء.")
    while True:
        try:
            q = input("\nأنت: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if q in ("خروج", "exit", "quit"):
            break
        if q:
            print("\nالمساعد:", agent.ask(q))


if __name__ == "__main__":
    main()
