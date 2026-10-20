# 演示数据库生成脚本

`gen_demo_data.py` 用来生成一份可以直接复制到网关 data 目录启动的 `ldmapi.db`。
它不是手写 BoltDB，而是启动一个本地假上游和当前源码编译出的网关，通过管理接口创建渠道、模型、令牌，再真实调用 `/v1/*` 与 `/api/chat`，让网关自己写出日志、统计和令牌用量。

生成过程不会修改你现有的数据目录，只在系统临时目录里操作，最后复制出一个 db 文件。

## 环境要求

- Python 3.10+
- Go 1.25+（与项目 `go.mod` 一致）
- 不需要安装任何第三方 Python 包，全部使用标准库

如果机器上没有 Go，也可以用 `--binary` 指定已经编译好的网关：

```bash
python scripts/gen_demo_data.py --binary dist/ldmapi-windows-amd64.exe
```

没有 Go 时，`--spread-days`（把日志分布到最近 N 天）会自动跳过，日志保留生成时刻。

## 快速开始

在项目根目录执行：

```bash
python scripts/gen_demo_data.py --force
```

默认产物：

```text
demo-data/ldmapi.db
```

默认管理密码：`landamao`。

脚本结束时会打印主密钥，例如：

```text
主密钥: sk-ldm-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

登录后也可以在「令牌管理」里查看所有密钥。

## 使用生成的数据库

把 `ldmapi.db` 复制到任意数据目录，然后启动网关：

```bash
ldmapi -data <db 所在目录>
```

例如：

```bash
mkdir -p my-demo
cp demo-data/ldmapi.db my-demo/ldmapi.db
./ldmapi -data my-demo
```

浏览器打开控制台，用 `landamao` 登录即可。

> 亲和与冷却状态按项目设计只保存在内存里。复制 db 并重启后，这些运行时状态会从空闲开始；
> 日志里仍然保留亲和命中、冷却失败和完整的重试明细。

## 常用参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--out PATH` | `demo-data/ldmapi.db` | 输出的 db 路径 |
| `--admin-password PWD` | `landamao` | 生成库的管理端密码，至少 6 位 |
| `--spread-days N` | `7` | 把日志分布到最近 N 天；`0` 表示保留生成时刻 |
| `--binary PATH` | 空 | 使用现成网关二进制；不传则用 `go build` 编译当前源码 |
| `--seed N` | `20261019` | 随机种子，影响 Key 随机、日志时间分布等 |
| `--force` | 关闭 | 输出文件已存在时覆盖 |
| `--strict` | 关闭 | 场景覆盖校验不通过时直接失败 |
| `--keep-temp` | 关闭 | 保留临时数据目录和网关日志，便于排查 |

## 常见用法

生成到指定位置：

```bash
python scripts/gen_demo_data.py --out D:/demo/ldmapi.db --force
```

换管理密码：

```bash
python scripts/gen_demo_data.py --admin-password demo123456 --force
```

不想把日志分散到历史日期：

```bash
python scripts/gen_demo_data.py --spread-days 0 --force
```

使用已经编译好的二进制：

```bash
python scripts/gen_demo_data.py --binary dist/ldmapi-windows-amd64.exe --force
```

生成失败时保留临时目录，查看网关日志：

```bash
python scripts/gen_demo_data.py --keep-temp --force
```

在 CI 或批量生成时要求场景必须齐全：

```bash
python scripts/gen_demo_data.py --strict --force
```

## 生成内容

### 渠道（10 个）

| 渠道 ID | 类型 | 特点 |
| --- | --- | --- |
| `demo-main` | OpenAI | 单 Key 稳定主线路 |
| `demo-bulk` | OpenAI | 3 个 Key 顺序调度，固定 401 → 429 → 成功 |
| `demo-random` | OpenAI | 3 个 Key 随机调度 |
| `demo-deepseek` | OpenAI | 3 个 Key 顺序 + Key 亲和，第一个 Key 固定 401 |
| `demo-anthropic` | Anthropic | 原生协议转换 |
| `demo-gemini` | Gemini | `/v1beta` 路径，不自动补 `/v1` |
| `demo-revoked` | OpenAI | 上游固定返回 401 |
| `demo-ratelimit` | OpenAI | 上游固定返回 429 |
| `demo-broken` | OpenAI | 上游固定返回 500，用于故障转移和冷却 |
| `demo-legacy` | OpenAI | 渠道已禁用 |

所有上游地址都指向脚本启动的本地假上游，不依赖外网。

### 模型（35 个）

- 20 个渠道模型，覆盖 OpenAI / Anthropic / Gemini / DeepSeek / 通义千问，带上下文长度、最大输出、工具调用、思考、视觉等能力参数。
- 15 个自定义模型，覆盖：
  - `chat-default`：分组优先级 + 组内 70/30 加权随机
  - `chat-fast`：低延迟路由 + 兜底
  - `chat-affinity`：模型亲和
  - `reasoning-pro`：思考内容与思考 token
  - `chat-chain-retry`：先跨渠道失败转移，再在同一渠道内换 Key
  - `chat-key-retry`：多 Key 顺序重试
  - `chat-limit-retry`：429 后切渠道
  - `chat-cooldown`：全部路由冷却
  - `chat-cooldown-reset`：全部冷却时自动重置
  - `chat-auth-fail`：上游 401 最终失败
  - `chat-partial-routes`：正常、渠道禁用、模型缺失三种路由状态并存
  - `chat-ghost` / `chat-empty` / `chat-disabled`：不可用、未配置、已停用
  - `my-local-llm`：归属自定义提供商「演示实验室」

模型广场状态会覆盖：

```text
ok / disabled / channel_disabled / channel_missing /
model_missing / no_routes / unavailable
```

### 令牌（7 个）

- `演示主密钥`：全模型，额度 50M
- `演示-移动端`：限制可调用模型
- `演示-试用额度`：30 天后过期
- `演示-已过期`：过期状态
- `演示-已禁用`：禁用状态
- `演示-额度耗尽`：额度 1000，已被一次大用量请求打满
- `演示-仅嵌入`：只允许调用 embedding 模型

### 日志覆盖

默认生成约 77 条日志，实际条数会随版本和随机种子略有变化。覆盖：

- 渠道重试
- 渠道重试后继续 Key 重试
- 单 Key 渠道
- 多 Key 渠道一次成功
- 顺序 Key、随机 Key、Key 亲和
- 模型亲和命中
- 429 限流转移
- 401、403、400、500、503
- 全部路由冷却、冷却自动重置
- 流式成功、首字耗时、输出速度
- 思考字符 / 思考 token、缓存 token
- 客户端主动取消（黄色 200，记成功）
- 上游中途断开（红色 200，记错误）
- embeddings、completions、原生 `/v1/messages`
- 在线聊天（管理端 playground）日志

日志默认分布到最近 7 天，并保证每个有调用的模型在今天至少有一条记录，所以模型广场的「近 24h」不会是一片 0。

## 脚本做了什么

1. 用 `go build` 编译当前源码；失败时尝试 `dist/` 下对应平台的可执行文件。
2. 在 `127.0.0.1` 的随机空闲端口启动假上游，模拟 OpenAI / Anthropic / Gemini 的成功、401、429、500、流式中断和慢速流。
3. 在另一个随机空闲端口启动网关，数据目录使用系统临时目录。
4. 通过管理接口写入站点设置、提供商、渠道、模型和令牌。
5. 发送真实请求生成日志、统计和令牌用量。
6. 停止网关，按需把日志时间重新分布到最近 N 天，并重建小时统计。
7. 把临时目录里的 `ldmapi.db` 复制到 `--out`。
8. 清理临时目录和进程。

整个过程不会写入你正在使用的 `data/ldmapi.db`，也不会占用固定端口。

## 排查

**输出文件已存在**

加 `--force`，或换一个 `--out`。

**`go build` 失败**

确认 Go 版本符合 `go.mod`，或者直接用 `--binary` 指定已经编译好的程序。

**登录失败**

使用脚本最后打印的管理密码。默认是 `landamao`；如果传了 `--admin-password`，用你传的值。

**日志时间不对**

默认会把日志分布到最近 7 天。想保留生成时刻，加 `--spread-days 0`。

**想看生成过程中的网关日志**

加 `--keep-temp`，脚本会打印临时目录路径；里面的 `gateway.log` 是网关输出。

**界面还是旧数据**

确认启动的是新复制过去的 `ldmapi.db`，并强制刷新浏览器。如果之前用同一个浏览器登录过别的库，退出后重新登录。

## 说明

- 所有上游 Key、令牌都是演示用的假数据，不包含任何真实密钥。
- 生成过程不访问外网；假上游完全在本机。首次 `go build` 如果依赖未缓存，Go 可能会自行下载模块。
- 生成的 `*.db` 已被 `.gitignore` 忽略，不会误提交。
- 脚本可以重复运行，每次都会生成一份新的独立数据库；不会覆盖旧的运行数据，除非你用 `--out` 指向它并加 `--force`。
