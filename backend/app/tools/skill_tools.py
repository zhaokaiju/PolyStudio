"""
Skill 文件读取工具

提供 read_file 和 ls 两个工具，供 agent 在 Progressive Loading 模式下
按需读取 SKILL.md 及其 references/、scripts/ 等子资源。

安全限制：路径必须在 skills/ 目录内，防止越权访问。
"""
import logging
from pathlib import Path
from typing import Optional

from langchain_core.tools import tool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# skills/ 目录的绝对路径（backend/skills/）
_SKILLS_ROOT = (Path(__file__).parent.parent.parent / "skills").resolve()


def _safe_resolve(path_str: str) -> Path | None:
    """
    将路径字符串解析为绝对路径，并验证是否在 skills/ 目录内。
    不在范围内返回 None。
    """
    try:
        p = Path(path_str)
        # 相对路径转绝对（相对于 skills/ 目录）
        if not p.is_absolute():
            p = _SKILLS_ROOT / p
        resolved = p.resolve()
        # 安全检查：必须在 skills/ 目录树内
        resolved.relative_to(_SKILLS_ROOT)
        return resolved
    except (ValueError, OSError):
        return None


# ─── read_file ────────────────────────────────────────────────────────

class ReadFileInput(BaseModel):
    path: str = Field(description="要读取的文件路径（绝对路径或相对于 skills/ 的路径）")
    start_line: Optional[int] = Field(default=None, description="起始行号（1-based，可选）")
    end_line: Optional[int] = Field(default=None, description="结束行号（1-based，含，可选）")


@tool("read_skill_file", args_schema=ReadFileInput)
def read_skill_file_tool(path: str, start_line: Optional[int] = None, end_line: Optional[int] = None) -> str:
    """
    读取 skill 文件内容。用于加载 SKILL.md 及其 references/、scripts/ 等子文件。
    路径必须在 skills/ 目录内。支持按行范围读取。
    """
    resolved = _safe_resolve(path)
    if resolved is None:
        return f"Error: 路径不在允许范围内或无效: {path}"
    if not resolved.exists():
        return f"Error: 文件不存在: {path}"
    if not resolved.is_file():
        return f"Error: 不是文件: {path}"

    try:
        lines = resolved.read_text(encoding="utf-8").splitlines()
    except Exception as e:
        return f"Error: 读取失败: {e}"

    start = (start_line - 1) if start_line else 0
    end = end_line if end_line else len(lines)
    selected = lines[start:end]

    # 带行号输出，方便 agent 定位
    return "\n".join(f"{start + i + 1}: {line}" for i, line in enumerate(selected))


# ─── ls ──────────────────────────────────────────────────────────────

class LsInput(BaseModel):
    path: str = Field(description="要列出的目录路径（绝对路径或相对于 skills/ 的路径）")


@tool("list_skill_dir", args_schema=LsInput)
def list_skill_dir_tool(path: str) -> str:
    """
    列出 skill 目录下的文件和子目录。用于探索 SKILL.md 同级的 references/、scripts/ 等资源。
    路径必须在 skills/ 目录内。
    """
    resolved = _safe_resolve(path)
    if resolved is None:
        return f"Error: 路径不在允许范围内或无效: {path}"
    if not resolved.exists():
        return f"Error: 目录不存在: {path}"
    if not resolved.is_dir():
        return f"Error: 不是目录: {path}"

    try:
        entries = sorted(resolved.iterdir(), key=lambda p: (p.is_file(), p.name))
    except Exception as e:
        return f"Error: 无法列出目录: {e}"

    lines = []
    for entry in entries:
        if entry.name.startswith("."):
            continue
        prefix = "📄" if entry.is_file() else "📁"
        lines.append(f"{prefix} {entry.name}")

    return "\n".join(lines) if lines else "(空目录)"
