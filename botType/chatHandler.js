// chatHandler.js

import fetch from "node-fetch";
import { PassThrough } from "stream";
import FormData from "form-data";
import { log } from '../config/logger.js';
import { logApiCall, generateId, getFileExtension, getFileType } from "./utils.js";

// 导入实用工具函数（假设定义在 utils.js 中）
const sessionMap = new Map();

function getSessionKey(req) {
  return (
    req.headers["x-session-id"] ||
    req.body.user ||
    req.headers["authorization"] ||
    "default"
  );
}

function normalizeUsage(usage) {
  return {
    prompt_tokens: Number(usage?.prompt_tokens || 0),
    completion_tokens: Number(usage?.completion_tokens || 0),
    total_tokens: Number(usage?.total_tokens || 0),
  };
}

function mergeUsage(currentUsage, newUsage) {
  const current = normalizeUsage(currentUsage);
  const next = normalizeUsage(newUsage);

  return {
    prompt_tokens: current.prompt_tokens + next.prompt_tokens,
    completion_tokens: current.completion_tokens + next.completion_tokens,
    total_tokens: current.total_tokens + next.total_tokens,
  };
}

function getSessionState(sessionKey) {
  const sessionState = sessionMap.get(sessionKey);

  if (!sessionState) {
    return {
      conversationId: "",
      cumulativeUsage: normalizeUsage(),
    };
  }

  if (typeof sessionState === "string") {
    return {
      conversationId: sessionState,
      cumulativeUsage: normalizeUsage(),
    };
  }

  return {
    conversationId: sessionState.conversationId || "",
    cumulativeUsage: normalizeUsage(sessionState.cumulativeUsage),
  };
}

function updateSessionState(sessionKey, conversationId, usage) {
  const previousState = getSessionState(sessionKey);
  const nextState = {
    conversationId: conversationId || previousState.conversationId || "",
    cumulativeUsage: mergeUsage(previousState.cumulativeUsage, usage),
  };

  sessionMap.set(sessionKey, nextState);
  return nextState;
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (content?.type === "text") {
    return content.text || "";
  }

  return "";
}

function sanitizeClineTextBlock(text) {
  const trimmedText = text.trim();

  if (!trimmedText) {
    return "";
  }

  if (trimmedText.startsWith("# task_progress RECOMMENDED")) {
    return "";
  }

  if (trimmedText.startsWith("<environment_details>")) {
    return "";
  }

  if (
    trimmedText.startsWith(
      "[ERROR] You did not use a tool in your previous response!"
    )
  ) {
    return "";
  }

  return trimmedText;
}

function extractSystemPrompt(messages) {
  const systemMessage = messages.find((message) => message.role === "system");

  if (!systemMessage) {
    return "";
  }

  if (Array.isArray(systemMessage.content)) {
    return systemMessage.content
      .map((content) => extractTextContent(content))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return String(systemMessage.content || "").trim();
}

function safeParseJsonString(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function extractToolCallsFromAgentThought(agentThought, toolCallStartIndex = 0) {
  if (!agentThought?.tool) {
    return [];
  }

  const toolNames = String(agentThought.tool)
    .split(";")
    .map((name) => name.trim())
    .filter(Boolean);

  if (toolNames.length === 0) {
    return [];
  }

  const parsedToolInput = safeParseJsonString(agentThought.tool_input);

  return toolNames.map((toolName, offset) => {
    const toolArguments =
      parsedToolInput && typeof parsedToolInput === "object"
        ? parsedToolInput[toolName] ?? parsedToolInput
        : {};

    return {
      index: toolCallStartIndex + offset,
      id: `call_${agentThought.id || generateId()}_${offset}`,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(toolArguments || {}),
      },
    };
  });
}

function extractToolInstructions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return "";
  }

  const serializedTools = tools
    .map((tool) => {
      const functionDef = tool?.function;

      if (!functionDef?.name) {
        return "";
      }

      const segments = [`name: ${functionDef.name}`];

      if (functionDef.description) {
        segments.push(`description: ${functionDef.description}`);
      }

      if (functionDef.parameters) {
        segments.push(
          `parameters: ${JSON.stringify(functionDef.parameters)}`
        );
      }

      return segments.join("\n");
    })
    .filter(Boolean);

  if (serializedTools.length === 0) {
    return "";
  }

  return [
    "Available tools:",
    serializedTools.map((toolText) => `- ${toolText}`).join("\n"),
    "When a tool is required, respond with a tool call that matches one of the available tools.",
  ].join("\n");
}

function serializeAssistantToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return "";
  }

  return toolCalls
    .map((toolCall) => {
      const functionName = toolCall?.function?.name || "unknown_tool";
      const functionArguments = toolCall?.function?.arguments || "{}";

      return [
        `tool_call_id: ${toolCall.id || generateId()}`,
        `tool_name: ${functionName}`,
        `tool_arguments: ${functionArguments}`,
      ].join("\n");
    })
    .join("\n\n");
}

function clipText(text, maxLength) {
  const normalizedText = String(text || "").trim();

  if (!normalizedText || normalizedText.length <= maxLength) {
    return {
      text: normalizedText,
      truncated: false,
      originalLength: normalizedText.length,
    };
  }

  const headLength = Math.max(Math.floor(maxLength * 0.65), 200);
  const tailLength = Math.max(maxLength - headLength, 80);
  const clippedText = [
    normalizedText.slice(0, headLength).trimEnd(),
    `[truncated ${normalizedText.length - maxLength} chars]`,
    normalizedText.slice(-tailLength).trimStart(),
  ].join("\n...\n");

  return {
    text: clippedText,
    truncated: true,
    originalLength: normalizedText.length,
  };
}

function parsePositiveInt(value, fallbackValue) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return parsedValue;
}

function getMessageText(message, { filterClineMeta = false } = {}) {
  let text = "";

  if (Array.isArray(message.content)) {
    for (const content of message.content) {
      const rawTextContent = extractTextContent(content);
      const textContent = filterClineMeta
        ? sanitizeClineTextBlock(rawTextContent)
        : rawTextContent;

      if (textContent) {
        text += `${textContent}\n`;
      }
    }
    return text.trim();
  }

  const rawTextContent = String(message.content || "");
  return filterClineMeta
    ? sanitizeClineTextBlock(rawTextContent)
    : rawTextContent.trim();
}

function serializeMessageForDify(
  message,
  { filterClineMeta = false, clipToolOutput = false } = {}
) {
  const rawContentText = getMessageText(message, { filterClineMeta });
  const isToolRole =
    message.role === "tool" || message.role === "function";
  const contentMeta =
    clipToolOutput && isToolRole
      ? clipText(rawContentText, 1800)
      : {
          text: rawContentText,
          truncated: false,
          originalLength: rawContentText.length,
        };
  const contentText = contentMeta.text;

  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    const toolCallsText = serializeAssistantToolCalls(message.tool_calls);
    const segments = [];

    if (contentText) {
      segments.push(`assistant: ${contentText}`);
    }

    if (toolCallsText) {
      segments.push(`assistant_tool_calls:\n${toolCallsText}`);
    }

    return {
      text: segments.join("\n\n").trim(),
      meta: {
        truncated: false,
        originalLength: rawContentText.length,
        role: message.role,
      },
    };
  }

  if (message.role === "tool" || message.role === "function") {
    const toolName = message.name || message.tool_call_id || "tool";
    return {
      text: contentText ? `tool (${toolName}): ${contentText}` : "",
      meta: {
        truncated: contentMeta.truncated,
        originalLength: contentMeta.originalLength,
        role: message.role,
      },
    };
  }

  return {
    text: contentText ? `${message.role}: ${contentText}` : "",
    meta: {
      truncated: contentMeta.truncated,
      originalLength: contentMeta.originalLength,
      role: message.role,
    },
  };
}

function buildStatelessChatQuery(messages) {
  const serializedMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const { text: contentText } = serializeMessageForDify(message, {
        filterClineMeta: message.role === "user",
      });

      if (!contentText) {
        return "";
      }

      return `${message.role}: ${contentText}`;
    })
    .filter(Boolean);

  return serializedMessages.join("\n\n");
}

function buildCompressedStatelessChatQuery(
  messages,
  {
    recentConversationLimit = 6,
    toolOutputMaxChars = 1800,
  } = {}
) {
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const recentToolChain = [];
  let index = nonSystemMessages.length - 1;

  while (
    index >= 0 &&
    (nonSystemMessages[index].role === "tool" ||
      nonSystemMessages[index].role === "function")
  ) {
    recentToolChain.unshift(nonSystemMessages[index]);
    index -= 1;
  }

  if (
    index >= 0 &&
    nonSystemMessages[index].role === "assistant" &&
    Array.isArray(nonSystemMessages[index].tool_calls) &&
    nonSystemMessages[index].tool_calls.length > 0
  ) {
    recentToolChain.unshift(nonSystemMessages[index]);
    index -= 1;
  }

  const earlierMessages = nonSystemMessages.slice(0, index + 1);
  const recentConversation = earlierMessages.slice(-recentConversationLimit);
  const omittedCount = Math.max(
    earlierMessages.length - recentConversation.length,
    0
  );
  const sections = [];
  let truncatedToolMessageCount = 0;

  if (omittedCount > 0) {
    sections.push(
      `[context compressed: omitted ${omittedCount} older non-system messages]`
    );
  }

  const recentConversationText = recentConversation
    .map((message) => {
      const { text } = serializeMessageForDify(message, {
        filterClineMeta: message.role === "user",
      });

      return text;
    })
    .filter(Boolean)
    .join("\n\n");

  if (recentConversationText) {
    sections.push(`Recent conversation:\n${recentConversationText}`);
  }

  const recentToolChainText = recentToolChain
    .map((message) => {
      const rawContentText = getMessageText(message);
      const clippedToolText = clipText(rawContentText, toolOutputMaxChars);
      const isToolRole =
        message.role === "tool" || message.role === "function";
      const toolName = message.name || message.tool_call_id || "tool";
      let text = "";
      let meta = {
        truncated: false,
        originalLength: rawContentText.length,
      };

      if (
        message.role === "assistant" &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0
      ) {
        const toolCallsText = serializeAssistantToolCalls(message.tool_calls);
        const segments = [];

        if (rawContentText) {
          segments.push(`assistant: ${rawContentText}`);
        }

        if (toolCallsText) {
          segments.push(`assistant_tool_calls:\n${toolCallsText}`);
        }

        text = segments.join("\n\n").trim();
      } else if (isToolRole) {
        text = clippedToolText.text
          ? `tool (${toolName}): ${clippedToolText.text}`
          : "";
        meta = {
          truncated: clippedToolText.truncated,
          originalLength: clippedToolText.originalLength,
        };
      } else {
        text = rawContentText ? `${message.role}: ${rawContentText}` : "";
      }

      if (meta?.truncated) {
        truncatedToolMessageCount += 1;
      }

      return text;
    })
    .filter(Boolean)
    .join("\n\n");

  if (recentToolChainText) {
    sections.push(`Latest tool interaction:\n${recentToolChainText}`);
  }

  return {
    query: sections.join("\n\n"),
    meta: {
      originalMessageCount: nonSystemMessages.length,
      omittedMessageCount: omittedCount,
      keptRecentConversationCount: recentConversation.length,
      keptToolChainCount: recentToolChain.length,
      truncatedToolMessageCount,
      recentConversationLimit,
      toolOutputMaxChars,
    },
  };
}

function buildStatefulToolQuery(
  messages,
  { toolOutputMaxChars = 1800 } = {}
) {
  const tailMessages = [];
  let index = messages.length - 1;

  while (
    index >= 0 &&
    (messages[index].role === "tool" || messages[index].role === "function")
  ) {
    tailMessages.unshift(messages[index]);
    index -= 1;
  }

  if (
    index >= 0 &&
    messages[index].role === "assistant" &&
    Array.isArray(messages[index].tool_calls) &&
    messages[index].tool_calls.length > 0
  ) {
    tailMessages.unshift(messages[index]);
  }

  const serializedMessages = tailMessages
    .map((message) => {
      if (message.role === "tool" || message.role === "function") {
        const rawContentText = getMessageText(message);
        const clippedToolText = clipText(rawContentText, toolOutputMaxChars);
        const toolName = message.name || message.tool_call_id || "tool";

        return clippedToolText.text
          ? `tool (${toolName}): ${clippedToolText.text}`
          : "";
      }

      return serializeMessageForDify(message, { clipToolOutput: true }).text;
    })
    .filter(Boolean);

  if (serializedMessages.length === 0) {
    return "";
  }

  return [
    ...serializedMessages,
    "Please continue based on the tool call context and tool results above.",
  ].join("\n\n");
}

function getContextMode(req, config) {
  const headerContextMode = req.headers["x-context-mode"];
  const contextMode = String(
    headerContextMode || config.CONTEXT_MODE || "stateful"
  ).toLowerCase();

  return contextMode === "stateless" ? "stateless" : "stateful";
}

function getCompressionConfig(req, config) {
  return {
    recentConversationLimit: parsePositiveInt(
      req.headers["x-context-recent-messages"] || config.CONTEXT_RECENT_MESSAGES,
      6
    ),
    toolOutputMaxChars: parsePositiveInt(
      req.headers["x-context-tool-max-chars"] || config.CONTEXT_TOOL_MAX_CHARS,
      1800
    ),
  };
}

/**
 * 从 Dify 文本响应中解析代码块，转换为 OpenAI tool_calls 格式
 * 让 Dify Chat 应用的代码输出可以被 opencode 等客户端实际执行
 */
function extractCodeBlockToolCalls(text) {
  if (!text) return { toolCalls: [], cleanText: text || "" };

  const MAX_TOOL_CALLS = 20;
  const toolCalls = [];
  const seenCommands = new Set();
  let cleanText = text;

  // 匹配 ```language\n...\n``` 代码块
  const codeBlockRegex = /```(\w+)\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (toolCalls.length >= MAX_TOOL_CALLS) break;

    const [fullMatch, language, codeContent] = match;
    const trimmedCode = codeContent.trim();
    if (!trimmedCode) continue;

    const lang = language.toLowerCase();

    // bash/shell 命令
    if (["bash", "sh", "shell", "zsh"].includes(lang)) {
      if (seenCommands.has(trimmedCode)) continue;
      seenCommands.add(trimmedCode);

      // --- 模式 1: cat > file << 'EOF' → write_file ---
      const catMatch = matchCatToFile(trimmedCode);
      if (catMatch) {
        toolCalls.push(makeTool("write_file", {
          path: catMatch.path,
          content: catMatch.body,
        }));
      }
      // --- 模式 2: echo "content" > file → write_file ---
      else {
        const echoMatch = matchEchoToFile(trimmedCode);
        if (echoMatch) {
          toolCalls.push(makeTool("write_file", {
            path: echoMatch.path,
            content: echoMatch.body,
          }));
        }
        // --- 模式 3: find 命令 → glob ---
        else {
          const findMatch = matchFindToGlob(trimmedCode);
          if (findMatch) {
            toolCalls.push(makeTool("glob", findMatch));
          }
          // --- 兜底: 纯 bash 命令 ---
          else {
            toolCalls.push(makeTool("bash", { command: trimmedCode }));
          }
        }
      }
      cleanText = cleanText.replace(fullMatch, "").trim();
    }

    // java/scala/kotlin → write_file (如果模型在代码块第一行写文件路径)
    // 通过检测代码块前的文字中的文件路径来推断
  }

  // --- 从文本中检测 skill 调用意图 ---
  // 匹配模式: "use the X skill" / "使用 X skill" / "load X"
  const skillNames = extractSkillReferences(cleanText);
  for (const skillName of skillNames) {
    if (toolCalls.length >= MAX_TOOL_CALLS) break;
    // 避免重复 skill 调用
    if (toolCalls.some(tc => tc.function.name === "skill" &&
      JSON.parse(tc.function.arguments).name === skillName)) continue;
    toolCalls.push(makeTool("skill", { name: skillName }));
  }

  return { toolCalls, cleanText: cleanText || "" };
}

/** 生成标准 tool_call 对象 */
function makeTool(name, args) {
  return {
    id: `call_${generateId()}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 匹配 cat > path << 'EOF' ... EOF 和 cat << 'EOF' > path ... EOF */
function matchCatToFile(code) {
  // 匹配两种顺序: cat > path << EOF 或 cat << EOF > path
  const headerPatterns = [
    /^cat\s+>\s*(\S+)\s+<<\s*'(EOF|END)'/m,       // cat > file << 'EOF'
    /^cat\s+<<\s*'(EOF|END)'\s*>\s*(\S+)/m,        // cat << 'EOF' > file
  ];
  for (const hre of headerPatterns) {
    const header = code.match(hre);
    if (!header) continue;
    // 两个正则的 group 顺序不同，统一提取
    const [_, g1, g2] = header;
    const isAltOrder = g1 === "EOF" || g1 === "END";
    const filePath = isAltOrder ? g2 : g1;
    const endMarker = isAltOrder ? g1 : g2;
    const bodyStart = code.indexOf("\n", header.index) + 1;
    const endRegex = new RegExp(`^${endMarker}$`, "m");
    const remainder = code.slice(bodyStart);
    const endMatch = endRegex.exec(remainder);
    const body = (endMatch
      ? remainder.slice(0, endMatch.index)
      : remainder
    ).trimEnd();
    return body ? { path: filePath, body } : null;
  }
  return null;
}

/** 匹配 echo "content" > file 或 echo 'content' > file */
function matchEchoToFile(code) {
  // 单行 echo "content" > /path
  const single = code.match(/^echo\s+["']([\s\S]*?)["']\s*>\s*(\S+)$/m);
  if (single) return { path: single[2], body: single[1] };

  // 多行 echo "line1\nline2" > /path  — 较少见，保持 bash
  return null;
}

/** 匹配 find 命令转换为 glob 参数 */
function matchFindToGlob(code) {
  // find /path -name "*.java" → glob pattern="*.java" path="/path"
  const findMatch = code.match(
    /^find\s+(\S+)\s+-name\s+["'](\S+)["'](?:\s+-type\s+[fd])?/m
  );
  if (!findMatch) return null;
  return {
    pattern: findMatch[2],
    path: findMatch[1],
  };
}

/**
 * 从响应文本中检测 skill 调用意图
 * 匹配模式: "use the X skill", "使用 X skill", "load X", "call X"
 * 仅在用户已安装的 skill 列表中匹配
 */
function extractSkillReferences(text) {
  if (!text) return [];

  // 已知 skill 列表 (安装自 .agents/skills/)
  const KNOWN_SKILLS = [
    "git-essentials", "code", "debug-pro", "find-skills",
    "test-runner", "memory", "session-logs", "self-improving",
    "architecture-designer", "security-auditor", "brainstorming",
    "backtest-expert", "content-strategy", "copywriting",
    "market-research", "seo", "blog-writer", "writing-plans",
    "executing-plans", "frontend-design-3", "ui-ux-pro-max",
    "ffmpeg-video-editor", "video-frames", "tmux", "autoglm-browser-agent",
    "parallel-web-search", "parallel-deep-research", "desearch-web-search",
    "clawdefender", "a-stock-analysis", "1password",
  ];

  const found = [];
  const textLower = text.toLowerCase();
  const skillRefPattern = /(?:use|load|call|invoke|run|用|使用|调用|加载|执行)\s+(?:the\s+)?([\w-]+)\s*(?:skill|工具|技能)/gi;
  let m;
  while ((m = skillRefPattern.exec(textLower)) !== null) {
    const candidate = m[1].toLowerCase();
    // 模糊匹配 skill 名
    for (const skillName of KNOWN_SKILLS) {
      if (skillName === candidate || skillName.includes(candidate) || candidate.includes(skillName)) {
        if (!found.includes(skillName)) found.push(skillName);
      }
    }
  }

  // 中文格式: "使用 git-essentials 这个 skill"
  const cnPattern = /使用\s*([\w-]+)\s*(?:skill|技能|工具)?/gi;
  while ((m = cnPattern.exec(text)) !== null) {
    const candidate = m[1].toLowerCase();
    if (KNOWN_SKILLS.includes(candidate) && !found.includes(candidate)) {
      found.push(candidate);
    }
  }

  return found.slice(0, 5); // 最多 5 个
}

// 上传文件到 Dify 并获取文件 ID
async function uploadFileToDify(base64Data, config, userId) {
  try {
    // 解析 base64 数据 URL，提取 contentType 和 base64 字符串
    const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error("Invalid base64 data");
    }
    let contentType = matches[1];
    const base64String = matches[2];
    let fileData = Buffer.from(base64String, "base64");

    // 如果 contentType 是 'image/jpg'，将其调整为 'image/jpeg'
    if (contentType === "image/jpg") {
      contentType = "image/jpeg";
    }

    // 从 contentType 确定文件扩展名
    const fileExtension = contentType.split("/")[1]; // 例如 'jpeg'、'png'、'gif'

    // 使用扩展名创建文件名
    const filename = `image.${fileExtension}`;

    // 创建 FormData 并包含 'user' 字段
    const form = new FormData();
    form.append("file", fileData, {
      filename: filename,
      contentType: contentType,
    });
    form.append("user", userId); // 使用提供的用户标识符

    // 记录文件上传请求的详细信息
    log("info", "正在上传文件到 Dify", {
      url: `${config.DIFY_API_URL}/files/upload`,
      headers: {
        Authorization: `Bearer ${config.API_KEY}`,
        ...form.getHeaders(),
      },
      formData: "<<FILE DATA>>", // 出于安全考虑，不记录实际文件数据
    });

    // 发送上传请求
    const response = await fetch(`${config.DIFY_API_URL}/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    // 记录文件上传响应的详细信息
    log("info", "文件上传响应", {
      status: response.status,
      statusText: response.statusText,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      log("error", "文件上传失败", {
        status: response.status,
        statusText: response.statusText,
        errorBody: errorBody,
      });
      throw new Error(
        `文件上传失败: ${response.status} ${response.statusText}: ${errorBody}`
      );
    }

    const result = await response.json();
    log("info", "文件上传成功", { fileId: result.id });
    return result.id; // 返回文件 ID
  } catch (error) {
    console.error("上传文件出错:", error);
    throw error;
  }
}

// 处理 Chat 类型的请求
async function handleRequest(req, res, config, requestId, startTime) {
  try {
    const apiPath = "/chat-messages";
    const sessionKey = getSessionKey(req);
    const data = req.body;
    const contextMode = getContextMode(req, config);
    const compressionConfig = getCompressionConfig(req, config);
    // 支持客户端通过 conversation_id 传入来恢复会话，否则从 sessionMap 获取
    const clientConversationId = data.conversation_id || "";
    const { conversationId: storedConversationId } = getSessionState(sessionKey);
    const existingConversationId =
      contextMode === "stateful"
        ? clientConversationId || storedConversationId
        : "";
    // 客户端传入 conversation_id 时同步更新 sessionMap
    if (contextMode === "stateful" && clientConversationId) {
      sessionMap.set(sessionKey, {
        conversationId: clientConversationId,
        cumulativeUsage: normalizeUsage(),
      });
    }
    const messages = data.messages;
    let queryString = "";
    let files = [];

    // 记录收到的请求头和请求体
    log("info", "收到请求", {
      requestId,
      headers: req.headers,
      body: data,
    });

    const userId = "apiuser"; // 如果可用，替换为实际的用户 ID
    const lastMessage = messages[messages.length - 1];
    
    // 第一步：先扫描所有消息中的图片内容
    log("info", "开始扫描所有消息中的图片", { requestId, messageCount: messages.length });
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if (content.type === "image_url" && content.image_url && content.image_url.url) {
            const imageUrl = content.image_url.url;
            
            // 检查URL是否为base64数据
            if (imageUrl.startsWith('data:')) {
              // 是base64数据，需要上传
              const fileExt = getFileExtension(imageUrl);
              const fileType = getFileType(fileExt);
              log("info", "检测到base64数据，准备上传", { requestId, fileType, fileExt });
              const fileId = await uploadFileToDify(
                imageUrl,
                config,
                userId
              );
              files.push({
                type: fileType,
                transfer_method: "local_file",
                upload_file_id: fileId,
              });
            } else {
              // 是真正的URL，直接使用remote_url方式
              const fileExt = getFileExtension(imageUrl);
              const fileType = getFileType(fileExt);
              log("info", "检测到远程文件URL", { requestId, url: imageUrl.substring(0, 30) + '...', fileType, fileExt });
              files.push({
                type: fileType,
                transfer_method: "remote_url",
                url: imageUrl,
              });
            }
          }
        }
      }
    }
    
    const systemPrompt = extractSystemPrompt(messages);
    const hasRequestedTools = Array.isArray(data.tools) && data.tools.length > 0;
    const hasToolMessages = messages.some(
      (message) =>
        message.role === "tool" ||
        message.role === "function" ||
        (message.role === "assistant" &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.length > 0)
    );
    const shouldAdaptToolCalls = hasRequestedTools || hasToolMessages;
    const toolInstructions = shouldAdaptToolCalls
      ? extractToolInstructions(data.tools)
      : "";
    let compressionMeta = null;

    // 第二步：根据上下文模式提取 query
    const shouldFilterClineMeta = Boolean(existingConversationId);
    const lastMessageRole = lastMessage?.role || "";
    const isToolFollowup =
      lastMessageRole === "tool" || lastMessageRole === "function";

    if (contextMode === "stateless") {
      const compressedContext = buildCompressedStatelessChatQuery(
        messages,
        compressionConfig
      );
      queryString = compressedContext.query;
      compressionMeta = compressedContext.meta;
    } else if (isToolFollowup) {
      queryString = buildStatefulToolQuery(messages, compressionConfig);
    } else {
      queryString = getMessageText(lastMessage, {
        filterClineMeta: shouldFilterClineMeta,
      });
    }

    const promptSections = [];

    if ((contextMode === "stateless" || !existingConversationId) && systemPrompt) {
      promptSections.push(systemPrompt);
    }

    // 注入代码块输出指令：让 Dify Chat 以 ```bash 代码块输出可执行命令
    if (contextMode === "stateless" || !existingConversationId) {
      promptSections.push(
        "当你需要执行命令或创建文件时，请用代码块输出可执行的命令。\n" +
        "- shell/bash 命令请用 ```bash ... ``` 包裹\n" +
        "- 每个命令单独一个代码块\n" +
        "- 不要模拟执行，直接输出要运行的命令"
      );
    }

    if (toolInstructions) {
      promptSections.push(toolInstructions);
    }

    if (queryString) {
      promptSections.push(queryString);
    }

    queryString = promptSections.join("\n\n---\n\n");

    log("info", "上下文策略已应用", {
      requestId,
      contextMode,
      hasConversationId: Boolean(existingConversationId),
      messageCount: messages.length,
      queryLength: queryString.length,
      hasOpenAITools: hasRequestedTools,
      hasToolMessages,
      shouldAdaptToolCalls,
      isToolFollowup,
      compressionConfig,
      compressionMeta,
      includedSystemPrompt:
        (contextMode === "stateless" || !existingConversationId) &&
        Boolean(systemPrompt),
      filteredClineMeta:
        contextMode === "stateless" ? true : shouldFilterClineMeta,
    });

    // 记录消息处理
    log("info", "处理 Chat 类型消息", {
      requestId,
      messageCount: messages.length,
      lastMessageRole: lastMessage.role,
      hasFiles: files.length > 0,
      queryString,
      files,
    });

    const stream = data.stream !== undefined ? data.stream : false;

    // 为 Dify 准备请求体
    const requestBody = {
      inputs: {},
      query: queryString,
      response_mode: "streaming",
      conversation_id: contextMode === "stateful" ? existingConversationId : "",
      user: userId, // 确保一致的 'user' 标识符
      auto_generate_name: false,
      files: files,
    };

    // 记录将要发送到 Dify 的请求载荷
    log("info", "发送请求到 Dify", {
      requestId,
      url: config.DIFY_API_URL + apiPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.API_KEY}`,
      },
      body: requestBody,
    });

    // 发送请求到 Dify
    const resp = await fetch(config.DIFY_API_URL + apiPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    // 记录 API 调用的持续时间
    const apiCallDuration = Date.now() - startTime;
    logApiCall(requestId, config, apiPath, apiCallDuration);

    // 记录 Dify 的响应状态
    log("info", "收到 Dify 响应", {
      requestId,
      status: resp.status,
      statusText: resp.statusText,
    });

    if (!resp.ok) {
      const errorBody = await resp.text();
      log("error", "Dify API 请求失败", {
        requestId,
        status: resp.status,
        statusText: resp.statusText,
        errorBody: errorBody,
      });
      res.status(resp.status).send(errorBody);
      return;
    }

    let isResponseEnded = false;

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      let buffer = "";
      let fullText = "";
      let usage = null;
      let conversationIdFromResp = null;
      let toolCallCount = 0;
      let hasToolCalls = false;
      const emittedAgentThoughtIds = new Set();
      const responseStream = resp.body
        .pipe(new PassThrough())
        .on("data", (chunk) => {
          buffer += chunk.toString();
          let lines = buffer.split("\n");

          for (let i = 0; i < lines.length - 1; i++) {
            let line = lines[i].trim();

            if (!line.startsWith("data:")) continue;
            line = line.slice(5).trim();
            let chunkObj;
            try {
              if (line.startsWith("{")) {
                chunkObj = JSON.parse(line);
              } else {
                continue;
              }
            } catch (error) {
              console.error("解析 chunk 出错:", error);
              continue;
            }

            // 记录每个 chunk 的内容
            //   log('debug', '处理 chunk', {
            //     requestId,
            //     chunkObj,
            //   });

            if (chunkObj.conversation_id) {
              conversationIdFromResp = chunkObj.conversation_id;
            }

            if (
              chunkObj.event === "message" ||
              chunkObj.event === "agent_message" ||
              chunkObj.event === "text_chunk"
            ) {
              let chunkContent;
              if (chunkObj.event === "text_chunk") {
                chunkContent = chunkObj.data.text;
              } else {
                chunkContent = chunkObj.answer;
              }

              if (chunkContent !== "") {
                fullText += chunkContent;
                const chunkId = `chatcmpl-${Date.now()}`;
                const chunkCreated = chunkObj.created_at;

                if (!isResponseEnded) {
                  res.write(
                    "data: " +
                      JSON.stringify({
                        id: chunkId,
                        object: "chat.completion.chunk",
                        created: chunkCreated,
                        model: data.model,
                        choices: [
                          {
                            index: 0,
                            delta: {
                              content: chunkContent,
                            },
                            finish_reason: null,
                          },
                        ],
                      }) +
                      "\n\n"
                  );
                }
              }
            } else if (chunkObj.event === "message_end") {
              const chunkId = `chatcmpl-${Date.now()}`;
              const chunkCreated = chunkObj.created_at;
              usage = chunkObj.metadata?.usage || null;

              // 从积累文本中提取代码块作为 tool_calls（streaming 模式）
              const {
                toolCalls: codeBlockToolCalls,
                cleanText: cleanedFullText,
              } = extractCodeBlockToolCalls(fullText);
              const hasCodeBlockToolCalls = codeBlockToolCalls.length > 0;

              // 如果有代码块 tool_calls，先发出 tool_call delta 事件
              if (hasCodeBlockToolCalls && !isResponseEnded) {
                const toolCallDelta = {
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created: chunkCreated,
                  model: data.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: codeBlockToolCalls.map((tc, i) => ({
                          index: toolCallCount + i,
                          id: tc.id,
                          type: tc.type,
                          function: tc.function,
                        })),
                      },
                      finish_reason: null,
                    },
                  ],
                };
                res.write("data: " + JSON.stringify(toolCallDelta) + "\n\n");
                toolCallCount += codeBlockToolCalls.length;
              }

              // finish_reason: 有 Agent tool_calls 或有代码块 tool_calls 时都是 tool_calls
              const finishReason =
                hasToolCalls || hasCodeBlockToolCalls
                  ? "tool_calls"
                  : "stop";
              let updatedSessionState = null;
              if (contextMode === "stateful" && conversationIdFromResp) {
                updatedSessionState = updateSessionState(
                  sessionKey,
                  conversationIdFromResp,
                  usage
                );
              }
              log("info", "流式响应完成", {
                requestId,
                conversationId: conversationIdFromResp,
                usage,
                cumulativeUsage: updatedSessionState?.cumulativeUsage,
                contentLength: fullText.length,
              });
              if (!isResponseEnded) {
                res.write(
                  "data: " +
                    JSON.stringify({
                      id: chunkId,
                      object: "chat.completion.chunk",
                      created: chunkCreated,
                      model: data.model,
                      choices: [
                        {
                          index: 0,
                          delta: {},
                          finish_reason: finishReason,
                        },
                      ],
                      usage: updatedSessionState?.cumulativeUsage || usage,
                    }) +
                    "\n\n"
                );
              }
              // conversation_id 由服务端 sessionMap 管理，不需要返回给客户端
              if (!isResponseEnded) {
                res.write("data: [DONE]\n\n");
              }

              res.end();
              isResponseEnded = true;
            } else if (chunkObj.event === "agent_thought") {
              if (
                shouldAdaptToolCalls &&
                !emittedAgentThoughtIds.has(chunkObj.id) &&
                chunkObj.tool
              ) {
                const toolCalls = extractToolCallsFromAgentThought(
                  chunkObj,
                  toolCallCount
                );

                if (toolCalls.length > 0 && !isResponseEnded) {
                  emittedAgentThoughtIds.add(chunkObj.id);
                  toolCallCount += toolCalls.length;
                  hasToolCalls = true;
                  const chunkId = `chatcmpl-${Date.now()}`;
                  const chunkCreated = chunkObj.created_at;

                  res.write(
                    "data: " +
                      JSON.stringify({
                        id: chunkId,
                        object: "chat.completion.chunk",
                        created: chunkCreated,
                        model: data.model,
                        choices: [
                          {
                            index: 0,
                            delta: {
                              tool_calls: toolCalls,
                            },
                            finish_reason: null,
                          },
                        ],
                      }) +
                      "\n\n"
                  );
                }
              }
            } else if (chunkObj.event === "ping") {
              // 如果需要，处理 ping 事件
            } else if (chunkObj.event === "error") {
              console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
              res
                .status(500)
                .write(
                  `data: ${JSON.stringify({ error: chunkObj.message })}\n\n`
                );

              if (!isResponseEnded) {
                res.write("data: [DONE]\n\n");
              }

              res.end();
              isResponseEnded = true;
            }
          }

          buffer = lines[lines.length - 1];
        });

      // 记录响应结束
      responseStream.on("end", () => {
        log("info", "响应结束", { requestId });
      });
    } else {
      let result = "";
      let usageData = null;
      let responseUsage = null;
      let conversationId = null;
      let toolCallCount = 0;
      const collectedToolCalls = [];
      const collectedAgentThoughtIds = new Set();
      let buffer = "";
      let hasError = false;

      // 记录普通响应的开始
      log("info", "开始处理普通响应", {
        requestId,
        timestamp: new Date().toISOString(),
      });

      const responseStream = resp.body;
      responseStream.on("data", (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split("\n");

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line === "") continue;
          let chunkObj;
          try {
            const cleanedLine = line.replace(/^data: /, "").trim();
            if (cleanedLine.startsWith("{") && cleanedLine.endsWith("}")) {
              chunkObj = JSON.parse(cleanedLine);
            } else {
              continue;
            }
          } catch (error) {
            console.error("解析 JSON 出错:", error);
            continue;
          }

          //   // 记录每个 chunk 的内容
          //   log('debug', '处理 chunk', {
          //     requestId,
          //     chunkObj,
          //   });

          if (
            chunkObj.event === "message" ||
            chunkObj.event === "agent_message"
          ) {
            result += chunkObj.answer;
          } else if (chunkObj.event === "message_end") {
            let updatedSessionState = null;
            if (chunkObj.conversation_id) {
              conversationId = chunkObj.conversation_id;
            }
            usageData = {
              prompt_tokens: chunkObj.metadata?.usage?.prompt_tokens,
              completion_tokens: chunkObj.metadata?.usage?.completion_tokens,
              total_tokens: chunkObj.metadata?.usage?.total_tokens,
            };
            if (contextMode === "stateful" && conversationId) {
              updatedSessionState = updateSessionState(
                sessionKey,
                conversationId,
                usageData
              );
            }
            if (updatedSessionState) {
              responseUsage = updatedSessionState.cumulativeUsage;
              log("info", "累计 usage 已更新", {
                requestId,
                conversationId,
                usage: usageData,
                cumulativeUsage: updatedSessionState.cumulativeUsage,
              });
            } else {
              responseUsage = usageData;
            }
          } else if (chunkObj.event === "workflow_finished") {
            const outputs = chunkObj.data.outputs;
            if (config.OUTPUT_VARIABLE) {
              result = outputs[config.OUTPUT_VARIABLE];
            } else {
              result = outputs;
            }
            result = String(result);
            usageData = {
              prompt_tokens: chunkObj.metadata?.usage?.prompt_tokens || 100,
              completion_tokens:
                chunkObj.metadata?.usage?.completion_tokens || 10,
              total_tokens: chunkObj.data.total_tokens || 110,
            };
            responseUsage = usageData;
          } else if (chunkObj.event === "agent_thought") {
            if (
              shouldAdaptToolCalls &&
              !collectedAgentThoughtIds.has(chunkObj.id) &&
              chunkObj.tool
            ) {
              const toolCalls = extractToolCallsFromAgentThought(
                chunkObj,
                toolCallCount
              );
              if (toolCalls.length > 0) {
                collectedAgentThoughtIds.add(chunkObj.id);
                toolCallCount += toolCalls.length;
                collectedToolCalls.push(...toolCalls);
              }
            }
          } else if (chunkObj.event === "ping") {
            // 如果需要，处理 ping 事件
          } else if (chunkObj.event === "error") {
            hasError = true;
            console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
            break;
          }
        }

        buffer = lines[lines.length - 1];
      });

      responseStream.on("end", () => {
        if (hasError) {
          res
            .status(500)
            .json({ error: "An error occurred while processing the request." });
        } else {
          const trimmedResult = result.trim();

          // 从文本中提取代码块作为 tool_calls
          const { toolCalls: codeBlockToolCalls, cleanText: cleanedResult } =
            extractCodeBlockToolCalls(trimmedResult);
          const hasCodeBlockToolCalls = codeBlockToolCalls.length > 0;
          const allToolCalls = [
            ...collectedToolCalls,
            ...codeBlockToolCalls,
          ];
          const hasToolCalls = allToolCalls.length > 0;
          // 清理 thinking 标签
          const rawContent = hasCodeBlockToolCalls ? cleanedResult : trimmedResult;
          const strippedContent = rawContent
            ? rawContent.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
            : "";
          const finalContent = strippedContent || null;
          const finishReason =
            hasToolCalls ? "tool_calls" : "stop";
          const formattedResponse = {
            id: `chatcmpl-${generateId()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: data.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: finalContent,
                  ...(allToolCalls.length > 0
                    ? { tool_calls: allToolCalls }
                    : {}),
                },
                logprobs: null,
                finish_reason: finishReason,
              },
            ],
            usage: responseUsage || usageData,
            system_fingerprint: "fp_2f57f81c11",
          };
          // 返回 conversation_id 给客户端
          if (contextMode === "stateful" && conversationId) {
            formattedResponse.conversation_id = conversationId;
          }
          const jsonResponse = JSON.stringify(formattedResponse, null, 2);

          // 记录发送的响应
          log("info", "发送响应", {
            requestId,
            response: formattedResponse,
            responseSummary: {
              conversationId,
              usage: usageData,
              returnedUsage: responseUsage || usageData,
              contentLength: finalContent ? finalContent.length : 0,
              toolCallCount: allToolCalls.length,
              hasCodeBlockToolCalls,
              finishReason,
            },
          });

          res.set("Content-Type", "application/json");
          res.send(jsonResponse);
        }
      });
    }
  } catch (error) {
    console.error("处理 Chat 请求时发生错误:", error);

    // 记录错误
    log("error", "处理 Chat 请求时发生错误", {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({ error: error.message });
  }
}

export default {
  handleRequest,
};
