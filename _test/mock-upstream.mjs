// 测试用的模拟上游服务：同时模拟 OpenAI 兼容端点与 Anthropic 端点。
// 用法：node mock-upstream.mjs <port> <openai|anthropic|gemini>
import http from 'node:http';

const port = Number(process.argv[2] || 4010);
const kind = process.argv[3] || 'openai';
const prefix = process.argv[4] || '';

const MODELS = ['a', 'b', 'c', 'd'].map((x) => prefix + x);

// 记录最近的请求，方便验证网关到底往上游发了什么协议
const recent = [];

function json(res, code, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...extra });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const bodyRaw = await readBody(req);
  let body = {};
  try { body = bodyRaw ? JSON.parse(bodyRaw) : {}; } catch { /* ignore */ }

  // 回显最近收到的请求（供人工核对协议转换结果）
  if (url.pathname === '/_recent') {
    return json(res, 200, { kind, recent });
  }
  recent.unshift({
    method: req.method,
    path: req.url,
    authHeaders: {
      authorization: req.headers['authorization'] || null,
      'x-api-key': req.headers['x-api-key'] || null,
      'x-goog-api-key': req.headers['x-goog-api-key'] || null,
      'anthropic-version': req.headers['anthropic-version'] || null,
    },
    body,
  });
  if (recent.length > 5) recent.pop();

  // 严格校验路径，模拟真实上游：端点不对就直接 404。
  // 这一步能真正验证网关是否把请求发到了各家的原生端点上。
  const EXPECT = {
    openai: /^\/v1\/(chat\/completions|completions|embeddings|models|images\/generations)/,
    anthropic: /^\/v1\/messages$/,
    gemini: /^\/v1beta\/models\/[^:]+:(generateContent|streamGenerateContent)$/,
  };
  if (!EXPECT[kind].test(url.pathname)) {
    if (kind === 'anthropic') {
      return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Not found: ' + url.pathname } });
    }
    if (kind === 'gemini') {
      return json(res, 404, { error: { code: 404, message: 'not found: ' + url.pathname, status: 'NOT_FOUND' } });
    }
    return json(res, 404, { error: { message: 'Unknown endpoint: ' + url.pathname, type: 'invalid_request_error' } });
  }

  // 健康/模型列表
  if (req.method === 'GET' && (url.pathname.endsWith('/models'))) {
    if (kind === 'gemini') {
      return json(res, 200, { models: MODELS.map((m) => ({ name: 'models/' + m, displayName: m })) });
    }
    if (kind === 'anthropic') {
      return json(res, 200, { data: MODELS.map((m) => ({ id: m, type: 'model' })) });
    }
    return json(res, 200, { object: 'list', data: MODELS.map((m) => ({ id: m, object: 'model' })) });
  }

  // 认证检查
  const auth = req.headers['authorization'] || '';
  const xkey = req.headers['x-api-key'] || '';
  const gkey = req.headers['x-goog-api-key'] || '';
  if (!auth && !xkey && !gkey) {
    return json(res, 401, { error: { message: 'missing api key', type: 'invalid_request_error' } });
  }

  const isChat = /chat\/completions|\/messages|generatecontent/i.test(url.pathname);
  if (!isChat) return json(res, 404, { error: { message: 'not found ' + url.pathname } });

  // 故意让模型名为 "fail" 的请求失败，用于测试路由回退
  const reqModel = body.model || '';
  if (reqModel.includes('fail')) {
    return json(res, 500, { error: { message: 'upstream boom', type: 'server_error' } });
  }
  if (reqModel.includes('ratelimit')) {
    return json(res, 429, { error: { message: 'rate limited', type: 'rate_limit_error' } });
  }

  const echo = [
    `kind=${kind}`,
    `path=${url.pathname}`,
    `model=${reqModel}`,
    `tools=${Array.isArray(body.tools) ? body.tools.length : 0}`,
    `hasImage=${JSON.stringify(body.messages || body.contents || []).includes('image')}`,
    `thinking=${body.thinking ? JSON.stringify(body.thinking) : (body.generationConfig ? JSON.stringify(body.generationConfig.thinkingConfig || null) : 'none')}`,
  ].join(' | ');

  // ---------- 流式 ----------
  const wantStream = !!body.stream || /streamgeneratecontent/i.test(url.pathname);
  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const words = ['你好', '，', '我是', '模拟', '上游', '。'];
    if (kind === 'openai') {
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: reqModel, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      // 模型名里带 think / reason 时先吐一段思考内容，用来验证折叠块
      if (/think|reason/i.test(reqModel)) {
        for (const w of ['用户发来了一个问候。', '这是一个很简单的社交场景，', '我应该友好地回应，', '并且主动询问对方需要什么帮助。']) {
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: reqModel, choices: [{ index: 0, delta: { reasoning_content: w }, finish_reason: null }] })}\n\n`);
        }
      }
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: reqModel, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })}\n\n`);
      }
      const streamUsage = {
        prompt_tokens: 11,
        completion_tokens: 6,
        total_tokens: 17,
        // 模拟提示词缓存命中，用来验证「缓存读」的展示
        prompt_tokens_details: { cached_tokens: 8 },
      };
      if (/think|reason/i.test(reqModel)) {
        streamUsage.completion_tokens_details = { reasoning_tokens: 30 };
        streamUsage.completion_tokens = 36;
        streamUsage.total_tokens = 47;
      }
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: reqModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: streamUsage })}\n\n`);
      res.write('data: [DONE]\n\n');
    } else if (kind === 'anthropic') {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: reqModel, usage: { input_tokens: 11, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      for (const w of words) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } })}\n\n`);
      }
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    } else {
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: w }] } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 6, totalTokenCount: 17 } })}\n\n`);
    }
    return res.end();
  }

  // ---------- 非流式 ----------
  if (kind === 'anthropic') {
    return json(res, 200, {
      id: 'msg_1', type: 'message', role: 'assistant', model: reqModel,
      content: [{ type: 'text', text: echo }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 6 },
    });
  }
  if (kind === 'gemini') {
    return json(res, 200, {
      candidates: [{ content: { role: 'model', parts: [{ text: echo }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 6, totalTokenCount: 17 },
    });
  }
  const message = { role: 'assistant', content: echo };
  if (/think|reason/i.test(reqModel)) {
    message.reasoning_content = '用户发来了一个问候。这是一个很简单的社交场景，我应该友好地回应，并且主动询问对方需要什么帮助。';
  }
  const usage = {
    prompt_tokens: 11,
    completion_tokens: 6,
    total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 8 },
  };
  if (/think|reason/i.test(reqModel)) {
    usage.completion_tokens_details = { reasoning_tokens: 30 };
    usage.completion_tokens = 36;
    usage.total_tokens = 47;
  }
  json(res, 200, {
    id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: reqModel,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage,
  });
});

server.listen(port, () => console.log(`mock upstream (${kind}) on http://127.0.0.1:${port}`));
