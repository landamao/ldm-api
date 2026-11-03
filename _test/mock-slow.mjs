// 慢速流式模拟上游：每 150ms 吐一段，用来验证「生成过程中能不能向上滚动」。
// 用法：node mock-slow.mjs [port]
import http from 'node:http';

const port = Number(process.argv[2] || 4011);

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

const LINES = [];
for (let i = 1; i <= 150; i += 1) {
  LINES.push(`第 ${i} 行：这是用来把对话区撑得很长的测试内容，方便在生成过程中向上滚动查看前面的历史消息。`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const raw = await readBody(req);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    return json(res, 200, { object: 'list', data: [{ id: 'slow', object: 'model' }] });
  }
  if (!/chat\/completions/i.test(url.pathname)) {
    return json(res, 404, { error: { message: 'not found ' + url.pathname } });
  }
  const model = body.model || 'slow';
  if (!body.stream) {
    return json(res, 200, {
      id: 'chatcmpl-slow', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: LINES.join('\n') }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 200, total_tokens: 211 },
    });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
  let i = 0;
  const timer = setInterval(() => {
    if (i >= LINES.length) {
      clearInterval(timer);
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 200, total_tokens: 211 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: LINES[i] + '\n' } }] })}\n\n`);
    i += 1;
  }, 100);
  req.on('close', () => clearInterval(timer));
});

server.listen(port, () => console.log(`slow mock upstream on http://127.0.0.1:${port}`));
