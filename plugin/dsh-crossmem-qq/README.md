# dsh-crossmem-qq

`dsh-crossmem` 的**可选**「QQ 域」插件。装了它，crossmem 才认识 QQ 桥接机器人的群/私聊；
不装，crossmem 只处理本机会话（不读任何 QQ 文件，面板里也没有 QQ 区块）。

## 它给 crossmem 提供什么

| 能力 | 说明 |
|---|---|
| 会话身份 | 读 QQ 桥的 `state/sessions.json`，把 `session-xxx` 反查成 `group:<群号>` / `private:<QQ号>` |
| 读取范围 | 池内 QQ 会话共享 `qq` 范围；池外会话只读自己的 |
| 写入范围 | 池内 → `qq`；池外 → `own:<会话>`；管理员私信 → `own:<会话>`（只进不出） |
| 注入额度 | QQ 会话默认 8 条 / 2000 字（本机是 5 条 / 800 字） |
| 抓取 | 解析桥接 prompt 末尾的【本次消息快照】，抽「我发X你回Y / X 就是 Y」这类口令 |
| 面板 | 设置页多一个「QQ 记忆库」区块：自由挑选任意多个会话进公共库 |

## 配置（profile 的 cordis.patch.yml 可覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `qqSessionsPath` | 自动探测 | QQ 桥的 `state/sessions.json` |
| `ownerPrivate` | `private:617171367` | 管理员私信（逗号分隔）：能读全库，写的不外流 |
| `injectCount` | `8` | QQ 会话注入条数 |
| `maxInjectChars` | `2000` | QQ 注入块字符上限 |
| `statePath` | `~/.dsh-crossmem/qq-state.json` | 公共记忆库成员列表（`qqPool`） |

## 安装

1. 把本目录放到 `<DSH_HOME>/profiles/desktop/node_modules/dsh-crossmem-qq`
2. profile `package.json`：
   - `dependencies` 加 `"dsh-crossmem-qq": "file:./node_modules/dsh-crossmem-qq"`
   - `dsh.profile.bundles` 在 `dsh-crossmem` 之后加 `"dsh-crossmem-qq"`
3. 重启 dsh

**卸载**就是删掉这两处 + 目录。core 会立刻退回「只处理本机会话」，QQ 那边写入的
`scope=qq` / `own:*` 记忆因为没人认领，会自动从本机注入里隐去（核心的安全默认）。

## 与 core 的协作方式

本插件在 `apply()` 时把自己的「域对象」push 进 `globalThis.__crossmemDomains`；
core 每次拼提示词/抓事实时取最后一个注册的域。接口只有 5 个方法：

```js
{
  id: 'qq',
  conversationOf(sessionId) -> 'group:123' | '',
  viewerOf(sessionId, ctx) -> { domain, conv, isQq, readScopes, writeScope, label, limits } | null,
  rowScope(row) -> 'qq' | 'own:<conv>' | '',     // 老数据的归属
  captureFacts(messages) -> [{ content, importance, rule }],
  isOwnerPrivate(conv) -> boolean,
}
```

所以以后要接抖音/微信/其它端，照着实现同一组方法即可，core 不用改。
