"""أدوات الـ agent. كل أداة: دالة + تعريف JSON schema."""
import ast
import datetime as dt
import json
import operator
from pathlib import Path

WORKDIR = Path.cwd().resolve()
NOTES = WORKDIR / ".agent_notes.json"

_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
        ast.USub: operator.neg}


def calculator(expression: str) -> str:
    def ev(n):
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return n.value
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.left), ev(n.right))
        if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.operand))
        raise ValueError("تعبير غير مسموح")
    return str(ev(ast.parse(expression, mode="eval").body))


def _safe(path: str) -> Path:
    p = (WORKDIR / path).resolve()
    if p != WORKDIR and WORKDIR not in p.parents:
        raise PermissionError("المسار خارج مجلد العمل")
    return p


def list_files(path: str = ".") -> str:
    return "\n".join(sorted(x.name + ("/" if x.is_dir() else "")
                            for x in _safe(path).iterdir()))


def read_file(path: str) -> str:
    return _safe(path).read_text(encoding="utf-8")[:20000]


def current_time() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _load():
    return json.loads(NOTES.read_text("utf-8")) if NOTES.exists() else {}


def save_note(key: str, value: str) -> str:
    d = _load(); d[key] = value
    NOTES.write_text(json.dumps(d, ensure_ascii=False, indent=2), "utf-8")
    return "تم الحفظ"


def recall_notes() -> str:
    return json.dumps(_load(), ensure_ascii=False)


def _t(name, desc, props=None, req=None):
    return {"name": name, "description": desc,
            "input_schema": {"type": "object", "properties": props or {},
                             "required": req or []}}


S = {"type": "string"}
TOOLS = [
    _t("calculator", "احسب تعبيرًا رياضيًا (+ - * / ** %)", {"expression": S}, ["expression"]),
    _t("list_files", "اعرض محتوى مجلد داخل مجلد العمل", {"path": S}),
    _t("read_file", "اقرأ ملف نصي من مجلد العمل", {"path": S}, ["path"]),
    _t("current_time", "التاريخ والوقت الحالي"),
    _t("save_note", "احفظ معلومة للرجوع لها لاحقًا", {"key": S, "value": S}, ["key", "value"]),
    _t("recall_notes", "استرجع كل الملاحظات المحفوظة"),
]
IMPL = {f.__name__: f for f in
        (calculator, list_files, read_file, current_time, save_note, recall_notes)}


def run_tool(name: str, args: dict) -> tuple[str, bool]:
    """يرجع (النتيجة, هل_فيه_خطأ)."""
    try:
        return str(IMPL[name](**args)), False
    except Exception as e:  # الخطأ يرجع للنموذج ليصلّح نفسه
        return f"خطأ: {e}", True
