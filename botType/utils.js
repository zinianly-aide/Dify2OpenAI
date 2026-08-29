// utils.js
import { log } from '../config/logger.js';

const SECRET_KEYS = /authorization|api[_-]?key|token|cookie|password|secret/i;
const CONTENT_KEYS = /^(content|prompt|query|answer|result|tool_result)$/i;

// 安全地记录对象（移除凭据与模型内容）
export function sanitizeLog(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((value) => sanitizeLog(value));
  if (typeof obj !== 'object') return obj;
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_KEYS.test(key)) sanitized[key] = '******';
    else if (CONTENT_KEYS.test(key)) sanitized[key] = '[redacted]';
    else if (key === 'messages' || key === 'tool_calls' || key === 'tools') {
      sanitized[`${key}Count`] = Array.isArray(value) ? value.length : 0;
    } else sanitized[key] = sanitizeLog(value);
  }
  return sanitized;
}

function safeModel(model) {
  if (typeof model !== 'string') return undefined;
  return model.includes('|') ? model.split('|')[0] : model.slice(0, 160);
}

// 记录请求元数据；不记录完整 header、prompt、message 或 tool result。
export function logRequest(req, requestId) {
  const body = req.body || {};
  log('info', '收到新请求', {
    requestId,
    method: req.method,
    url: req.url,
    contentType: req.headers?.['content-type'],
    model: safeModel(body.model),
    stream: body.stream === true,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    hasSessionIdentity: Boolean(req.headers?.['x-dsh-conversation-id'] || req.headers?.['x-session-id'] || body.dsh_conversation_id || body.session_id),
  });
}

// 记录响应元数据；不记录模型完整输出或工具结果。
export function logResponse(requestId, status, data) {
  log('info', '发送响应', {
    requestId,
    status,
    responseType: data?.object || data?.event || typeof data,
    hasError: Boolean(data?.error),
    choiceCount: Array.isArray(data?.choices) ? data.choices.length : undefined,
  });
}

// 记录API调用详情
export function logApiCall(requestId, config, apiPath, duration) {
  log('info', 'Dify API调用完成', {
    requestId,
    apiPath,
    botType: config.BOT_TYPE,
    durationMs: duration
  });
}

// 生成唯一的请求ID
export function generateId() {
  let result = "";
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 29; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// 从 URL 中提取文件扩展名
export function getFileExtension(url) {
  if (url.startsWith('data:')) {
    const mimeMatch = url.match(/data:([^;]+)/);
    if (mimeMatch && mimeMatch[1]) {
      const mime = mimeMatch[1];
      const mimeToExt = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'text/html': 'html',
        'audio/mpeg': 'mp3',
        'video/mp4': 'mp4'
      };
      return mimeToExt[mime] || 'bin';
    }
    return 'bin';
  }
  try {
    const cleanUrl = url.split('?')[0];
    const parts = cleanUrl.split('/');
    const filename = parts[parts.length - 1];
    const ext = filename.split('.').pop().toLowerCase();
    return ext || 'bin';
  } catch (error) {
    log('warn', '无法从 URL 提取文件扩展名', { error: error instanceof Error ? error.message : String(error) });
    return 'bin';
  }
}

export function getFileType(extension) {
  const documentExts = ['txt', 'md', 'markdown', 'pdf', 'html', 'xlsx', 'xls', 'docx', 'csv', 'eml', 'msg', 'pptx', 'ppt', 'xml', 'epub'];
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const audioExts = ['mp3', 'm4a', 'wav', 'webm', 'amr'];
  const videoExts = ['mp4', 'mov', 'mpeg', 'mpga'];
  const ext = extension.toLowerCase();
  if (documentExts.includes(ext)) return 'document';
  if (imageExts.includes(ext)) return 'image';
  if (audioExts.includes(ext)) return 'audio';
  if (videoExts.includes(ext)) return 'video';
  return 'custom';
}

export { log };
