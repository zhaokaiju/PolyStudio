# PolyStudio Skill 系统与多模态联动机制分析

## 一、Skill 加载与执行机制

### 1.1 发现与加载

Skill 系统以 **两级渐进式加载** 实现：

```
skills/public/ 或 skills/custom/ 目录
       │
       ▼
scan_available_skills() 扫描所有 SKILL.md
       │
       ▼
_parse_skill_md() 用正则 /^---\s*\n(.*?)\n---\s*\n(.*)/ 解析 frontmatter
       │
       ▼
只注入 name + description + 路径到 Agent Prompt
       │
       ▼
Agent 判断用户意图匹配后，调用 read_skill_file 工具按需加载完整内容
```

关键代码：`skill_service.py` 的 `scan_available_skills()` 扫描目录，`get_skills_context()` 仅注入元数据，`read_skill_file` 工具负责实际读取。

### 1.2 Progressive Loading 实现

Agent Prompt 中包含 `{skills_context}` 插槽，列出所有 Skill 的名称与描述。Agent 通过对比用户意图与 Skill 描述决定是否需要加载。加载后，SKILL.md 中的指令直接指导 Agent 的工具选择和执行顺序——例如 podcast-creator SKILL.md 明确规定了"先示例确认，再批量合成"的工作流程。

### 1.3 工具选择影响

SKILL.md 内容被读入后，作为上下文指令注入到 Agent 的思考链中。Agent 根据 Skill 内定义的步骤顺序调用对应工具，绕过 Skill 描述的随意性，保证专业领域流程的确定性执行。

## 二、多模态联动工作流（以虚拟人生成为例）

```
用户上传素材（图片/音频/视频）
       │
       ▼
qwen_omni_understand 多模态理解
（分析画面描述、音频语义）
       │
       ▼
generate_volcano_image / edit_volcano_image 生成角色形象
       │
       ▼
detect_face 人脸检测（必须通过才可继续）
       │
       ▼
generate_virtual_anchor 生成口型同步视频
（输入：角色图片 + 旁白音频）
       │
       ▼
最终成片输出
```

多模态理解结果（如视频画面描述、旁白文本）通过 **Agent 上下文** 在工具间传递：理解工具的 `text_response` 作为生成工具的 prompt 输入，实现跨模态信息流动。

## 三、数据流简图

```
用户上传媒体
     │
     ▼
┌─────────────────────────────────┐
│  qwen_omni_understand           │
│  (多模态理解 → text_response)     │
└───────────────┬─────────────────┘
                │ Agent 上下文传递
                ▼
┌─────────────────────────────────┐
│  角色生成 + 人脸检测 +             │
│  虚拟人合成（口型同步）             │
└─────────────────────────────────┘
```

**核心设计要点**：
- **按需加载**：元数据先行，完整内容延迟加载，避免每次对话膨胀。
- **Skill 约束流程**：SKILL.md 定义工具调用顺序，防止跳过关键步骤（如人脸检测）。
- **多模态串联**：理解结果作为生成 Prompt，音频驱动口型合成，形成完整创作链路。
