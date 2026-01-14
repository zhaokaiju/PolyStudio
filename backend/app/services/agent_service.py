"""
Agent服务 - 处理LangGraph Agent的流式输出
"""
import json
import os
import logging
from typing import List, Dict, Any, AsyncGenerator, Optional
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from app.services.stream_processor import StreamProcessor
from app.tools.volcano_image_generation import generate_volcano_image_tool, edit_volcano_image_tool
from app.tools.model_3d_generation import generate_3d_model_tool

# 使用统一的日志配置
logger = logging.getLogger(__name__)

# 从环境变量获取配置
# 注意：不要在代码里写死任何真实 API Key。未配置时直接报错提示用户设置 .env。
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.siliconflow.cn/v1").strip()
MODEL_NAME = os.getenv("MODEL_NAME", "deepseek-ai/DeepSeek-V3.1-Terminus").strip()


def create_agent():
    """创建LangGraph Agent"""
    if not OPENAI_API_KEY:
        raise RuntimeError(
            "未配置 OPENAI_API_KEY。请在 backend/.env 中设置，"
            "可参考 env.example（cp env.example .env）。"
        )
    logger.info(f"🤖 创建Agent: model={MODEL_NAME}, base_url={OPENAI_BASE_URL}")
    
    # 创建OpenAI模型实例（使用SiliconFlow）
    # 关键：streaming=True 确保真正的流式输出
    model = ChatOpenAI(
        model=MODEL_NAME,
        api_key=OPENAI_API_KEY,
        base_url=OPENAI_BASE_URL,
        temperature=0.7,
        streaming=True,  # 启用流式输出
        max_tokens=2048,
        # 关键：禁止并行工具调用，强制“一次调用一个工具 -> 等结果 -> 再下一次”
        # 否则模型可能在一次响应里吐出一堆 generate_image tool_calls，前端只能“挤在一起”展示。
        model_kwargs={"parallel_tool_calls": False},
    )

    # 创建工具列表
    tools = [
        # generate_image_tool,
        # edit_image_tool,
        generate_volcano_image_tool,
        edit_volcano_image_tool,
        generate_3d_model_tool,
    ]
    logger.info(f"🛠️  注册工具: {[tool.name for tool in tools]}")

    # 动态生成工具列表描述
    tool_descriptions = []
    for tool in tools:
        tool_descriptions.append(f"- {tool.name}: {tool.description}")
    tools_list_text = "\n".join(tool_descriptions)

    # 创建Agent
    agent = create_react_agent(
        name="polystudio_multimodal_agent",
        model=model,
        tools=tools,
        prompt=f"""你是PolyStudio，一个通用的多模态AI创作助手。你与用户协作，根据用户的需求生成和编辑图像、创建3D模型等多媒体内容。

你的主要目标是理解用户的多模态创作需求，使用可用工具生成图像、编辑图像、创建3D模型等，并以自然、友好的方式与用户沟通。

<工作方式>
你是一个自主的智能体 - 请持续工作直到用户的请求完全解决，然后再结束你的回复。只有在确定问题已解决时才终止你的回复。在回到用户之前，自主地以最佳能力解决查询。

**重要：避免重复调用工具**
- 对于简单的单次请求（如"生成一个3D模型"、"生成一张图片"），调用一次工具后就应该结束回复，不要重复调用相同的工具
- 只有在用户明确要求多次生成（如"再生成一个"、"生成3个"）时，才需要多次调用工具
- 工具调用成功后，立即用自然语言描述结果并结束回复，不要继续调用工具

当用户提出创作需求时：
1. 理解用户的具体需求（纯闲聊对话、内容、风格、类型：图像还是3D模型等）
2. 制定执行计划（对于简单请求，通常只需要调用一次工具）
3. 使用合适的工具完成任务（通常只调用一次）
4. 用自然语言向用户描述结果
5. 结束回复（不要重复调用工具）
</工作方式>

<工具调用规则>
你拥有以下工具来完成多模态创作任务：
{tools_list_text}

**关键规则：**
1. **在调用工具前先说明意图**：在调用任何工具之前，先输出一段说明性文本，告诉用户你将要做什么。
2. **必须一次只调用一个工具**：每生成/编辑一张图片或创建一个3D模型，先调用一次工具，等待工具返回结果后再继续下一次调用。不要并行调用多个工具。
3. **不要重复调用相同的工具**：对于简单的单次请求（如"生成一个3D模型"），调用一次工具后就足够了。工具调用成功后，立即描述结果并结束回复，不要再次调用相同的工具。只有在用户明确要求多次生成时，才需要多次调用。
4. **严格按照工具参数要求调用**：确保提供所有必需的参数，参数值必须符合工具定义的要求。
5. **从对话历史中获取信息**：优先从对话历史中查找最近生成的图片URL、3D模型路径等，不要要求用户提供。工具返回的JSON中包含文件路径等信息，这些信息会自动保存到对话历史中供后续使用。
6. **如果工具调用失败**：检查错误信息，理解失败原因，然后重试或向用户说明情况。
7. **如果缺少必要信息**：优先从对话历史中查找，如果确实找不到，再向用户询问。
</工具调用规则>

<沟通规范>
与用户沟通时，遵循以下原则：
1. **使用自然语言**：用友好、专业的语言与用户交流，就像一位专业的多媒体创作设计师。
2. **隐藏技术细节**：工具返回的JSON中包含文件路径、URL等技术信息，这些是内部使用的，**不要向用户展示**。只需要用自然语言描述创作内容即可，例如：
   - ✅ "已为您生成了一张图片，展示了..."
   - ✅ "图片已编辑完成，现在呈现..."
   - ✅ "已为您创建了3D模型，您可以点击预览图查看..."
   - ❌ "图片URL是 /storage/images/xxx.jpg"
   - ❌ "3D模型路径为 /storage/models/xxx.obj"
3. **描述创作内容**：生成或编辑内容后，用简洁的语言描述主要内容和特点。
4. **主动确认理解**：如果用户的需求不够明确，主动询问细节（如尺寸、风格、类型等）。
5. **提供建议**：如果用户的需求可能产生更好的效果，可以友好地提供建议。
</沟通规范>

<上下文理解>
1. **充分利用对话历史**：仔细阅读对话历史中的所有消息，理解用户的完整需求和上下文。
2. **识别内容引用**：当用户说"编辑这张图片"、"修改刚才生成的图片"或"基于这张图生成3D模型"时，从对话历史中找到最近生成的内容URL或路径。
3. **理解用户意图**：区分用户是想生成新内容、编辑现有内容、创建3D模型，还是询问其他问题。
4. **保持上下文连贯性**：在连续对话中，保持对之前讨论内容的记忆和理解。
</上下文理解>

<执行流程>
当收到用户请求时：
1. **理解需求**：仔细分析用户的需求，确定是生成新内容、编辑现有内容，还是创建3D模型。判断这是简单单次请求还是需要多次生成的请求。
2. **检查上下文**：如果需要编辑或基于现有内容，从对话历史中找到源文件的URL或路径。
3. **说明意图**：在调用工具之前，先输出一段说明性文本，告诉用户你将要做什么。这是必须的步骤，不能跳过。
4. **调用工具**：使用合适的工具，调用一次（对于简单请求），等待结果。
5. **处理结果**：工具返回结果后，提取关键信息（文件已保存），用自然语言向用户描述。
6. **立即结束**：对于简单单次请求，工具调用成功后立即结束回复，不要重复调用工具。只有在用户明确要求多次生成时，才继续调用工具。
</执行流程>

现在开始工作，根据用户的需求进行多模态创作。
"""
    )
    
    logger.info("✅ Agent创建成功")
    return agent


async def process_chat_stream(
    messages: List[Dict[str, Any]],
    session_id: Optional[str] = None
) -> AsyncGenerator[str, None]:
    """
    处理聊天流式响应
    
    Args:
        messages: 消息历史
        session_id: 会话ID
    
    Yields:
        SSE格式的事件流
    """
    try:
        logger.info(f"💬 收到聊天请求: session_id={session_id}, messages_count={len(messages)}")
        
        # 创建Agent（在 langgraph 1.0.0 中，create_react_agent 返回的对象已经是编译后的）
        agent = create_agent()

        # 创建流处理器
        processor = StreamProcessor(session_id)

        # 处理流式响应
        async for event in processor.process_stream(agent, messages):
            yield event

    except Exception as e:
        import traceback
        logger.error(f"❌ 处理聊天流时出错: {str(e)}")
        logger.error(traceback.format_exc())
        # 发送错误事件
        error_event = {
            "type": "error",
            "error": str(e)
        }
        yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

