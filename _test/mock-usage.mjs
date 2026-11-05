// 模拟「每个分块都带累积 usage」的上游（硅基流动就是这样）：
// 每块都下发一份 {prompt_tokens, completion_tokens: 累计, total_tokens: 累计}。
// 用来看在线聊天里的 token / 速度会不会被逐块累加放大。
//   usage-echo：单轮，40 块，每块带累积 usage
//   usage-tool：先回一次工具调用（usage 339/5），再回正文（usage 400/10）
//               —— 用来验证「跨工具轮相加、轮内只取最后一次」
// 用法：node mock-usage.mjs [port]
import http from 'node:http';

const port = Number(process.argv[2] || 4021);
const CHUNKS = 40;          // 单轮模型一共多少块
const GAP_MS = 100;         // 每块间隔
const PROMPT = 339;         // 单轮模型每块都报的输入 token

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}

const chunk = (model, delta, extra = {}) => `data: ${JSON.stringify({
  id: 'c1', object: 'chat.completion.chunk', model,
  choices: [{ index: 0, delta, ...(extra.finish ? { finish_reason: extra.finish } : {}) }],
  ...(extra.usage ? { usage: extra.usage } : {}),
})}\n\n`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const raw = await readBody(req);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    return json(res, 200, { object: 'list', data: [{ id: 'usage-echo', object: 'model' }, { id: 'usage-tool', object: 'model' }] });
  }
  if (!/chat\/completions/i.test(url.pathname)) {
    return json(res, 404, { error: { message: 'not found ' + url.pathname } });
  }

  const model = body.model || 'usage-echo';
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const afterTool = msgs.some((m) => m && m.role === 'tool');
  const usageAt = (p, n) => ({ prompt_tokens: p, completion_tokens: n, total_tokens: p + n });

  if (!body.stream) {
    return json(res, 200, {
      id: 'chatcmpl-usage', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: '（非流式）' }, finish_reason: 'stop' }],
      usage: usageAt(PROMPT, CHUNKS),
    });
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  // 工具轮：只回一个 tool_call，用量 339 / 5
  if (model === 'usage-tool' && !afterTool) {
    res.write(chunk(model, { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_current_time', arguments: '' } }] }, { usage: usageAt(339, 1) }));
    res.write(chunk(model, { tool_calls: [{ index: 0, function: { arguments: '{"timezone":"Asia/Shanghai"}' } }] }, { usage: usageAt(339, 5) }));
    res.write(chunk(model, {}, { finish: 'tool_calls', usage: usageAt(339, 5) }));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // 正文轮：工具轮之后用量变成 400 输入，10 输出
  const prompt = model === 'usage-tool' ? 400 : PROMPT;
  const total = model === 'usage-tool' ? 10 : CHUNKS;
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    if (i > total) {
      clearInterval(timer);
      res.write(chunk(model, {}, { finish: 'stop', usage: usageAt(prompt, total) }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(chunk(model, { content: `第${i}块 ` }, { usage: usageAt(prompt, i) }));
  }, GAP_MS);
  req.on('close', () => clearInterval(timer));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-usage listening on http://127.0.0.1:${port} (chunks=${CHUNKS}, prompt=${PROMPT})`);
});
