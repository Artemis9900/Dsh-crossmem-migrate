# dsh-crossmem ｜ 跨会话记忆

让 dsh 的**每个会话都能看到同一份记忆**：你在 A 会话里定下的规矩，B 会话一开口就知道。

## 它做什么

| 能力 | 怎么实现 | 成本 |
|---|---|---|
| **自动注入** | 挂 `system-prompt/assemble`，每次组装提示词时追加一段「跨会话记忆」 | 0 |
| **自动记录** | 挂 `agent/pre-step`，从用户消息里按启发式抓明确陈述 | 0 |
| **会话收尾抽取** | 挂 `session/flush`，把本轮消息交给本地 Ollama 抽 1-3 条 | 本地 GPU，无 API 费用 |
| **隐私隔离** | 记忆带 origin（`dsd` / `qq`），默认**不把 QQ 群聊记忆注入本机会话** | — |

## 装

```powershell
# 方式一：脚本
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 方式二：手动
robocopy . "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-crossmem" /E
# 然后在 profile 的 package.json 里把 dsh-crossmem 加进 dsh.profile.bundles
```

装完**彻底退出 dsh 再打开**。

## 验证

1. 调 `crossmem_stats`：能看到条数、来源分布、当前曲线。
2. 调 `crossmem_save` 写一条，再新开一个会话，看它的系统提示里有没有那段「跨会话记忆」。

> 这段是给 README 追加的「安装时检测本地模型」说明。用单独文件写，避免 shell 转义踩坑。

## 安装时会检查本地模型

`install.ps1` 会先看三件事：Ollama 有没有装、服务起没起、要用的模型在不在。三者缺一个就会**当场问你**：

```
ollama cli     : C:\Users\<你>\AppData\Local\Programs\Ollama\ollama.exe
ollama service : running
models         : (none)
need           : modelscope.cn/Qwen/Qwen3-8B-GGUF:Q4_K_M

  !! Local model NOT installed.
     The plugin works without it: heuristic capture + prompt injection still run.
     The local model only adds smarter capture at session end (zero API cost).

  Install it now? (~5 GB download) [y/N]
```

- 输入 `y` 就直接 `ollama pull`，装完再进 DSH。
- 输入 `n` 也能用：**启发式抓取和提示注入照常工作**，只是少了「会话收尾用本地模型多抽几条」。
- Ollama 本身没装时，会告诉你下载地址和手动命令，不会卡住安装。

非交互场景（脚本化）可以用参数：

```powershell
.\install.ps1 -Yes                 # 自动装模型，不问
.\install.ps1 -SkipModelCheck      # 完全不检查模型
.\install.ps1 -Model "qwen2.5:3b"   # 换一个更小的模型（约 1.9 GB）
```

### 运行时也会兜底

模型被删了、Ollama 关了，插件不会每次会话收尾都白等 60 秒：第一次要用时探一次，不可用就自动降级并记日志，`crossmem_stats` 里会显示：

```
本地抽取：不可用（模型没装：modelscope.cn/...）
```



## 控制菜单

设置页里有一页「跨会话记忆」，就是这个插件的控制台：

```
跨会话记忆 · v0.1 · b1                    库：memory-shared.db · 曲线 power · 注入 5 条

注入 [开]   自动记录 [开]   本地模型 ✓

关掉注入 = 下一轮起不再把记忆塞进系统提示（工具仍然可用）
关掉自动记录 = 不再往库里写新东西

打通会话（2 个）   [刷新] [全部取消]          共 48 个会话
只对下面 2 个会话注入记忆；其它会话不受影响。

[已打通] 抖音插件排查 · douyin-duty                          session-9d4b
[已打通] 课堂笔记 · 9.15计网课堂笔记                         session-a6ab
[打通]   Python 学习 · learn-python                          session-8258
...
```

**打通列表的行为**：

| 列表状态 | 效果 |
|---|---|
| 空（0 个） | 不限制，**所有会话共享**同一份记忆 |
| 非空 | **只对列表里的会话注入**；其它会话照常工作，只是看不到共享记忆 |

想加多少加多少，逐个点「打通」，重复点变「已打通」再点即取消。

### 没有面板也能配（命令行）

```powershell
.\rollback.ps1 -List                      # 看当前打通了哪些
.\rollback.ps1 -Link "session-9d4b4d59..."    # 加一个
.\rollback.ps1 -Unlink "session-9d4b4d59..."  # 取消
```

会话 id 可以在面板里看到，或者让助手调 `crossmem_sessions` 列出来。

### 面板背后的接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/crossmem/state` | 开关、打通列表、库位置、模型状态 |
| GET | `/api/crossmem/sessions` | 会话列表（加 `?refresh=1` 强制重扫） |
| POST | `/api/crossmem/link` | `{ sessionId, linked }` 加/取消打通 |
| POST | `/api/crossmem/switch` | `{ inject?, capture?, linkedSessions? }` |

会话扫描带 30 秒缓存（48 个会话全解压要 1-2 秒）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dbPath` | `~/.dsh-ebbinghaus/memory-shared.db` | 库文件（和 dsh-ebbinghaus、QQ 机器人共用一份） |
| `injectCount` | `5` | 本机会话每次注入几条（1-10） |
| `maxInjectChars` | `800` | 本机会话注入块最大字符数，超了截断 |
| `qqInjectCount` | `8` | **QQ 会话**每次注入几条（1-20） |
| `qqMaxInjectChars` | `2000` | **QQ 会话**注入块最大字符数 |
| `qqSessionsPath` | 自动探测 | QQ 桥的 `state/sessions.json`（会话→群/私聊 映射）。默认按 `配置 → CROSSMEM_QQ_SESSIONS → ~/.dsh-crossmem/qq-sessions.json → D:\deepseek memory\state\sessions.json` 找 |
| `includeQq` | `false` | 是否把 QQ 记忆也注入本机会话（隐私开关） |
| `autoCapture` | `true` | 启发式自动抓取 |
| `captureMinLen` | `6` | 抓取最短字数 |
| `captureLocal` | `true` | 会话收尾用本地 Ollama 抽取 |
| `ollamaUrl` | `http://127.0.0.1:11434` | 本地模型地址 |
| `ollamaModel` | `modelscope.cn/Qwen/Qwen3-8B-GGUF:Q4_K_M` | 抽取用的模型 |
| `curve` / `curveK` | `power` / `1.5` | 排序用的遗忘曲线 |

## QQ 内部打通：按「会话身份」而不是 session id

QQ 里学到的记忆以前是**半通**的：注入块只挑"全局最近 × 重要度"的 5 条，QQ 的会话身份
（`group:<群号>` / `private:<QQ号>`）根本没参与判断。现在分三档：

| 范围 | 谁能看到 | 什么时候用 |
|---|---|---|
| `shared` 公共区 | 所有会话 | 本机会话抓到的、你以为大家都该知道的 |
| `qq` | **QQ 会话都能看**；本机会话只有 `includeQq=true`、或它在同一打通组里时才看 | QQ 群里/私聊里学到的东西，默认落这里 |
| 组 id | 只有打通组里的会话 | 本机会话之间手动打通（QQ 会话固定写 `qq`） |

具体行为：

- **会话身份从哪来**：插件只读 QQ 桥的 `state/sessions.json`（`{ "group:916178625": "session-…" }`），
  反查出「这条 DSH 会话属于哪个群/哪个私聊」。读不到就一律按本机会话处理（宁可漏，不越界）。
- **QQ 里抓的事实**写 `scope=qq`、`source=crossmem:qq`、`subject=group:…`，于是：
  群 A 记下的，群 B 和私聊都看得到（跨群/跨天连续），本机会话看不到。
- **同会话优先**：同一个群/私聊里学到的记忆，排序加权 1.6 倍——跨群共享，但不会淹没"这个群自己的事"。
- **和打通组叠加**：把 QQ 会话和一个本机会话放进同一组，那条记忆会带上 `组:<gid>` 标记，
  于是组里的本机会话也能看到它，而组外的本机会话仍然看不到（QQ 之间不受影响，照样互通）。
- **老数据不用迁移**：桥以前写的行（`source=private:… / group:… / digest:* / slang*`，scope 还是
  `shared`）现在按来源自动判成 `qq`。所以升级后**本机会话会明显变干净**（QQ 的东西不再漏进来）。
- **黑话不占注入位**：`kind=slang` 的行不进注入块，用 `qq_slang_query` 查。
- **本机 vs QQ 额度分开**：本机 5 条 / 800 字；QQ 8 条 / 2000 字（`qqInjectCount`、`qqMaxInjectChars`）。

> 已知边界：QQ 桥的会话守卫（`qq-tool-restrict.mjs`）只放行 MCP 工具前缀，`crossmem_*` 默认仍在
> 拒绝名单里。也就是说 QQ 里的机器人**靠注入被动记忆**是通的，但主动 `crossmem_search` /
> `crossmem_save` 调用会被拒。要放开就把名字加进 `state/tool-allowlist.json` 或守卫的
> `SAFE_EXACT`（改 JSON 立即生效，不用重启）。

## 注入长什么样

```
【跨会话记忆 · 最近 5 条】
· [fact] 操作者用 RTX 4050 6GB，跑 8B 模型偏慢（硬件）
· [task] TEMP 短路径问题已修：用户级变量指向 D:\tmp-dy（修复）
· [person] 管理员要求叫爸爸（称呼）
（来源：本机各会话共享库；当前会话 sess-abc @ demo。要细查用 crossmem_search，要补记用 crossmem_save。）
```

## 隐私边界（重要）

记忆按 `source` 分两类：

| origin | 来源标记 | 默认注入本机会话？ |
|---|---|---|
| `dsd` | `crossmem:dsd` | ✅ 会 |
| `qq` | `qq-bridge` / `digest*` / `crossmem:qq*` | ❌ **不会** |

也就是说：**群里学到的东西，不会跑到你本地工作会话的提示词里**。要打通就把 `includeQq` 设成 `true`。

## QQ 专属配置（v0.3）

| 能力 | 在哪 | 说明 |
|---|---|---|
| QQ 公共记忆库 | 面板「QQ 公共记忆库」区块 / state.json 的 qqPool | 空 = 全部 QQ 会话共享（默认）；非空 = **只有池内会话**互相共享，移出的各自隔离（own:<会话>）。面板可自由加入任意多个会话，支持「全部加入 / 清空」 |
| 管理员私信（单向汇） | 插件配置 ownerPrivate（默认 private:617171367） | 能读所有会话的记忆；它自己写的不外流（scope=own:<会话>）。不能加入公共库 |
| 短期记忆 24h | 桥接 config.json 的 qqMemory.ttlHours（默认 24） | 话题/想法/群友印象 24h 内没再被提起就归档；再提到会自动续期 |
| 会话记忆库 | qqMemory.dbPath（默认 <桥目录>/state/qq-memory.db） | 独立于长期记忆库；每日整理（memoryDigest）直接从这个库摊平 |

## 已知边界

- **不是语义检索**：用 SQL `LIKE` 子串匹配（库只有几百条，够用）。要向量检索得加依赖，本插件刻意不引。
- **注入是全局的**：目前按「R × 重要度」挑，没有按工作目录过滤。后面可以加 `cwd` 相关性加权。
- **抽取出错会静默**：本地模型没起 / 超时，只记日志，不影响会话。
- **会写同一个库**：和 dsh-ebbinghaus、QQ 机器人共用 `memory-shared.db`，都开了 `busy_timeout`。


## 回退：只停注入，插件留着

这是**推荐的"撤销"方式**——不卸载、不重启，只是让插件闭嘴。

```powershell
powershell -ExecutionPolicy Bypass -File .\rollback.ps1
```

它往 `~/.dsh-crossmem/state.json` 写：

```json
{ "inject": false, "capture": false, "reason": "manual rollback", "at": 1793... }
```

效果：

| 行为 | 回退后 |
|---|---|
| 往系统提示里注入记忆 | ❌ 停 |
| 自动抓取事实（启发式 / 本地模型） | ❌ 停 |
| `crossmem_search` / `save` / `stats` / `recent` 工具 | ✅ **照常可用** |
| 插件本身 | ✅ 还装着，设置页还在 |

**立即生效**：插件每次注入/抓取前都会重读这个文件，不用重启 dsh。

### 「回到注入之前」到底能做到哪一步

要分清两层：

| 层 | 能不能回到之前 | 怎么做 |
|---|---|---|
| **下一轮的系统提示** | ✅ 完全回到 | 关开关就行。注入是每轮 `system-prompt/assemble` 现拼的，不落盘、不追加到消息历史 |
| **已经发生过的轮次** | ❌ 改不了 | 那几轮已经写进会话日志（`system/message`、`request/context`）。那是"当时的事实"，删掉反而让上下文不一致 |

所以：

- **想让"从现在起不再注入"** → `rollback.ps1`，下一轮就干净了。
- **想要"整个会话从来没有注入过"** → 新开一个会话（旧会话日志还在，但新会话不带任何痕迹）。

想确认某个会话里还有没有残留：

```powershell
.\rollback.ps1 -Scan                       # 扫全部会话
.\rollback.ps1 -Scan -ScanCwd "D:\proj"    # 只扫这个工作目录下的
```

输出：

```
⚠️  session-f8958276-...  含 19 处注入残留
扫描 48 个会话，1 个含注入痕迹。
说明：这是历史轮次留下的记录（当时确实注入过），不是"当前还在注入"。
```

> 扫描器只看 `system/message` 和 `request/context` 两类记录——**不能全文 grep**：
> 你在对话里讨论过「【跨会话记忆」这段话，会被误判成注入残留（实测踩过这个坑）。

### 想重新打开

```powershell
.\rollback.ps1 -On
```

或者让助手调 `crossmem_switch({ inject: true, capture: true })`。也可以只关一半：

```js
crossmem_switch({ capture: false })   // 只停自动记录，保留注入
```

### 查看当前状态

```powershell
.\rollback.ps1 -Status
```

### 和「卸载」的区别

| | `rollback.ps1` | `uninstall.ps1` |
|---|---|---|
| 停止注入 | ✅ | ✅ |
| 停止自动记录 | ✅ | ✅ |
| 工具还能用 | ✅ 能 | ❌ 没了 |
| 插件文件 | 保留 | 删除 |
| 需要重启 dsh | ❌ 不用 | ✅ 要 |
| 数据 | 保留 | 默认保留（`-PurgeData` 才删） |

一句话：**想静音用 rollback，想彻底不要了用 uninstall**。

## 回退（卸载）

**能回退，而且是一键的。**

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

它做三件事：

1. 从 profile 的 `package.json` 里删掉 `dsh-crossmem`（`bundles` + `dependencies`）
2. 删掉 `node_modules\dsh-crossmem` 目录
3. 改之前先把 `package.json` 备份成 `package.json.bak-uninstall-<时间戳>`

卸完**彻底退出 dsh 再打开**，插件就不再加载了。

### 数据怎么办

默认**保留**：记忆留在 `memory-shared.db` 里，只是不再注入、不再自动记录。

想连数据一起清干净：

```powershell
.\uninstall.ps1 -PurgeData
```

它只删 `source LIKE 'crossmem:%'` 的行——QQ 机器人写的（`qq-bridge` / `digest:*`）和 `dsh-ebbinghaus` 写的都不动。

### 想更彻底：整体回滚到安装前

```powershell
# 用卸载脚本生成的备份
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-uninstall-*" `
          "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Force
```

### 卸载验证

装 → 卸往返实测：

```
装完 bundles: @deepseek-ai/dsh-base, qq-agent-presets, dsh-crossmem
卸完 bundles: @deepseek-ai/dsh-base, qq-agent-presets     ← 恢复原样
deps        : x                                            ← 只剩原来那条
目录还在    : False
备份        : 1 个
```

`-PurgeData` 的删除范围也单独验过：

```
写入：crossmem:dsd / qq-bridge / crossmem:qq / digest:*
purge 删除 2 条；剩余 2 条：qq-bridge、digest:*
✅ 只删了 crossmem 的
```


## 许可

MIT
