dsh-crossmem   跨会话记忆插件  使用与设计说明

版本：dsh-crossmem 0.3.0  +  dsh-crossmem-qq 0.1.0（可选 QQ 域插件）
平台：DeepSeek Harness（DSH）0.2.x，Node ≥ 22
性质：纯本地 SQLite，不调用任何模型，零 API 费用

一句话：它让不同会话共享一份记忆——你在 A 会话说的事，B 会话开口就知道；群里定的口令，别的群也认；但管理员私聊里说的只留在私聊。

作用
自动记：从对话里抓明确陈述（「记住…」「我叫…」「我发 X 你回 Y」），不花 token
自动提醒：每轮往系统提示里塞一小段记忆（本机 5 条 / QQ 8 条），不用你主动问
分范围：本机共享 / 打通组 / QQ 公共库 / 管理员私信（单向：能读全库，写的不外流）
能管：设置页一个面板，开关注入与记录、拉打通组、挑哪些 QQ 会话进公共库
原理
只有一个东西是长期存在的：一张 SQLite 表（memories，字段有内容、重要度、来源、范围、强度）。所有花招都围绕它：

注入：挂 system-prompt/assemble 钩子，每次拼提示词时现查这张表，按「遗忘曲线 × 重要度」挑几条塞进去——不落盘、不追加历史，关掉开关下一轮就干净了。

抓取：挂 agent/pre-step 钩子，读最近两条用户消息，用正则抽事实写回表。QQ 那边不扫整段提示词（会抓出垃圾），而是解析桥接附在末尾的【本次消息快照】JSON，只取别人说的话。

范围靠 scope 字段：shared 人人可见、组id 组内可见、qq QQ 池内可见、own:<会话> 只有它自己——所以「谁能看到」是查表时过滤，不需要多开库。

拆成两个包：核心只认「会话 + 组 + scope」这套通用概念；QQ 的身份映射、公共库、口令规则放在可选的 QQ 域插件里，通过 5 个方法的接口注册给核心。不装它，核心就只服务本机会话。

和别的记忆插件共用一张表：dsh-ebbinghaus 负责「什么该忘」（遗忘曲线、复习、归档），QQ 桥负责「写什么进来」，crossmem 负责「现在提醒什么」。三方共表，靠 source 前缀区分来源。

一句话概括原理：一张表存所有记忆，两个钩子管「写」和「提醒」，一个 scope 字段管「谁能看」，一个可选域插件管「QQ 是谁」。

一、它解决什么问题


DSH 里每个会话是独立的上下文：你在 A 会话定下的规矩，B 会话完全不知道；
QQ 群里聊定的事，换一个群或私聊又重新问一遍。

这个插件让同一台机器上的会话共用一份记忆，并且：
  每轮自动把「该记的」注入到系统提示里（不用你手动问）
  从对话里自动抓取明确的事实（零成本，不花 token）
  用「范围（scope）」控制谁能看到：本机 / 打通组 / QQ 池 / 管理员私信

一句话：A 会话里说过的事，B 会话开口就知道；群里定的口令，别的群也认；
但管理员私聊里说的，只留在管理员私聊。



二、两个包的分工（v0.3 起拆开）


1) dsh-crossmem —— 核心（必装）
   只认「会话 + 打通组 + 范围」这套通用概念：
     注入：挂 system-prompt/assemble，每轮拼一段【跨会话记忆】
     抓取：挂 agent/pre-step，从用户消息里按启发式抽事实
     工具：crossmem_search / save / switch / sessions / groups / stats / recent
     面板：设置页「跨会话记忆」区块（开关、打通组、会话列表）
   它不认识 QQ，也不读任何 QQ 文件。

2) dsh-crossmem-qq —— QQ 域插件（可选）
   装了它，核心才认识 QQ 桥接机器人：
     会话身份：把 DSH 的 session-xxx 反查成 group:<群号> / private:<QQ号>
     读取范围：池内 QQ 会话共享 qq 范围；池外会话只读自己的
     写入范围：池内 → qq；池外 → own:<会话>；管理员私信 → own:<会话>
     注入额度：QQ 会话 8 条 / 2000 字（本机是 5 条 / 800 字）
     抓取：解析桥接 prompt 末尾的【本次消息快照】，抽「我发X你回Y」这类口令
     面板：设置页多一个「QQ 记忆库」区块，自由挑会话进公共库

两者通过一个 5 方法的「域接口」协作，注册在 globalThis.__crossmemDomains：
     conversationOf(sessionId)          会话 → 外部会话键
     viewerOf(sessionId, ctx)           这个会话能读什么、写什么、注入多少
     rowScope(row)                      老数据归属哪个范围
     captureFacts(messages)             从消息里抽事实（QQ 的快照/口令逻辑）
     isOwnerPrivate(conv)               是不是「只进不出」的管理员私信

以后要接抖音、微信或别的端，照这 5 个方法实现一个域即可，核心不用改。



三、四种可见范围（scope）


  范围            谁能看到                          什么时候用
  
  shared          所有会话                          公共知识、本机通用事实
  组 id           只有打通组内的会话                你手动把几个会话拉进一个组
  qq              池内 QQ 会话（本机需 includeQq）    QQ 群/私聊之间互通
  own:<会话>      只有那个会话自己                    管理员私信（只进不出）、池外会话

规则的优先级（重要）：
  1) shared 谁都能看
  2) own:xxx 只有 xxx 自己（连 includeQq 都绕不过）
  3) 其它范围看会话的 readScopes（组 id、qq 等）
  4) includeQqtrue 时，本机会话也能看到外部域的记忆（老开关，默认关）



四、注入长什么样


本机会话（5 条 / 800 字上限）：

  【跨会话记忆 最近 5 条】
  [fact] 操作者用 RTX 4050 6GB，跑 8B 模型偏慢（硬件）
  [task] 每晚 23:00 做回顾：写日记、改自述（定时任务）
  （来源：本机各会话共享库；当前会话 8b645252 @ 项目目录。要细查用
  crossmem_search，要补记用 crossmem_save。）

QQ 会话（8 条 / 2000 字上限）：

  【跨会话记忆 最近 8 条】
  [fact] 357 → 9955（原话：我发357你发9955）（跨会话/口令）
  [episode] 群内专属表情包，多次引发笑点（日整理）
  （来源：QQ group:916178625（跨群/跨天连续）；当前会话 1c5e407d @ agents。
  要细查用 crossmem_search，要补记用 crossmem_save。）

排序规则（踩过的坑）：
  本机：R（遗忘曲线）× 重要度
  QQ：一半名额给「24 小时内最新写入」，另一半再按分数补
    原因：只按分数排，刚学的口令会输给几个月前的重要度 5 老记忆，
          8 条名额被老内容占满，看起来就是「换个群就不记得」。
  同一个会话里学到的额外加权 1.6 倍（跨群共享但不淹没本群自己的事）
  kindslang（黑话）不进注入块，用 qq_slang_query 查



五、自动抓取（零成本）


本机会话：从用户消息里按句式抽，只在「明确陈述」时记：
  记住/记一下/别忘了：…
  我叫… / 我的名字是…
  以后都用… / 以后按…
  我喜欢/讨厌/不喜欢…
  不要/别再/禁止…

QQ 会话：不扫整段 prompt（会抓出 `你</message>` 这种垃圾），而是解析桥接
附在末尾的【本次消息快照】JSON，只取别人发的消息，再按规则抽：
  我发X你回Y / 我说X你答Y
  X 就是 Y / X 对应 Y / X  Y / X → Y
  抽到的口令标为 重要度 5 + 标签「口令」，写入 qq 范围。

另外还有「会话收尾本地模型抽取」（可选）：会话结束时把缓存的消息交给本地
Ollama 抽 1~3 条，不花 API 费用。模型没装会自动降级，不阻塞会话。


六、工具清单

  crossmem_search   跨会话检索（显式查询，不过滤范围）
  crossmem_save     写一条记忆（不填 scope 时按当前会话自动归档）
  crossmem_recent   最近 N 条
  crossmem_stats    库概况：条数、来源、注入额度、外部域、打通组、软开关
  crossmem_sessions 列出本机会话（按工作区归并，带打通组）
  crossmem_groups   打通组管理：list / create / delete / add / remove
  crossmem_switch   软开关：注入 / 自动记录（回退用，立即生效）

QQ 域插件额外提供：
  面板接口 GET/POST /api/crossmem-qq/state、/api/crossmem-qq/pool
  设置页「QQ 记忆库」区块（全部加入 / 清空 / 逐个加入）



七、配置


核心（dsh-crossmem）：

  键                默认                        说明
  
  dbPath            ~/.dsh-ebbinghaus/memory-shared.db   与 ebbinghaus、QQ 桥共用
  injectCount       5                           本机注入条数
  maxInjectChars    800                         本机注入块字符上限
  includeQq         false                       是否把外部域记忆也注入本机会话
  autoCapture       true                        启发式自动抓取
  captureMinLen     6                           抓取最短字数
  captureLocal      true                        会话收尾用本地 Ollama 抽取
  ollamaUrl         http://127.0.0.1:11434      本地模型地址
  ollamaModel       modelscope.cn/Qwen/Qwen3-8B-GGUF:Q4_K_M
  curve / curveK    power / 1.5                 排序用遗忘曲线
  statePath         ~/.dsh-crossmem/state.json  软开关 + 打通组

QQ 域（dsh-crossmem-qq）：

  键                默认                        说明
  
  qqSessionsPath    自动探测                     QQ 桥的 state/sessions.json
  ownerPrivate      private:617171367           管理员私信（逗号分隔）：只进不出
  injectCount       8                           QQ 注入条数
  maxInjectChars    2000                        QQ 注入块字符上限
  statePath         ~/.dsh-crossmem/qq-state.json   QQ 公共记忆库成员（qqPool）



八、安装 / 卸载


安装（手动）：
  1. 把插件目录放到 <DSH_HOME>/profiles/desktop/node_modules/<包名>
  2. profile 的 package.json：
       dependencies 加   "<包名>": "file:./node_modules/<包名>"
       dsh.profile.bundles 加 "<包名>"（core 在前，qq 在后）
  3. 彻底退出 DSH 再打开

  注意：package.json 必须是 UTF-8 无 BOM。带 BOM 会让 DSH 的 JSON.parse 抛错，
       该 bundle 会被静默跳过（不报错、只是不加载），排查起来非常费时间。

卸载：
  只静音：改 state.json 的 {"inject":false,"capture":false}，或跑 rollback.ps1
  彻底移除：删 bundles 与 dependencies 两处 + 删目录，重启
  只卸 QQ 域：删 dsh-crossmem-qq 那一行 + 目录；核心退回本机模式，
    QQ 那批 qq/own: 记忆会自动从本机注入里隐去（核心的安全默认）



九、数据在哪


  ~/.dsh-ebbinghaus/memory-shared.db   长期记忆库（与 dsh-ebbinghaus、QQ 桥共用）
                                       表 memories：content/importance/source/
                                       tags/strength/review_count/archived/scope
  ~/.dsh-crossmem/state.json           核心软开关 + 打通组
  ~/.dsh-crossmem/qq-state.json        QQ 公共记忆库成员（qqPool）
  <QQ桥目录>/state/qq-memory.db        QQ 会话记忆库（话题/想法/群友印象，24h TTL）
  <QQ桥目录>/state/sessions.json       QQ 会话映射（session-xxx → group/private）

记忆按 source 前缀区分来源，这条约定是跨插件可见性的关键：
  crossmem:dsd / crossmem:qq   本插件写的（本机 / QQ）
  private:<QQ号> / group:<群号>  QQ 桥按会话写的
  digest:<日期>                 QQ 桥每日整理
  slang.json / douyin / ''      其它来源



十、与 dsh-ebbinghaus 的关系


两者共用同一张 memories 表（同一个 SQLite 文件），但不是同一件事：

  crossmem     决定「现在该提醒什么」——注入 + 抓取
  ebbinghaus   决定「什么该忘掉」——遗忘曲线、复习、自动归档（只有工具，不注入）
  QQ 桥         决定「写什么进来」——qq_recall_*、每日 digest

三个真实耦合点，改任何一边都要注意：
  1) 归档会连带隐藏：ebbinghaus 把 archived 置 1，crossmem 的候选集过滤
     archived0，于是这条同时从注入里消失。
  2) 复习会改排序：ebb_search 命中会刷 last_used_at，而 crossmem 的 R 也用
     last_used_at，等于「被 ebbinghaus 搜过  在 crossmem 里更新鲜」。
  3) 曲线不一致：ebbinghaus 默认 exponential，crossmem 默认 power(k1.5)，
     同一行在两边算出的新鲜度不同，归档与排序各说各话。



十一、已知边界


  不是语义检索：SQL LIKE 子串匹配（库只有几百条，够用），刻意不引向量库
  注入没有 cwd 相关性：按范围 + 分数挑，不按工作目录加权
  本地抽取失败静默降级：模型没起/超时只写日志，不影响会话
  会话 id 会变：打通组按 DSH session id 绑定，会话重建后要重新点选；
     QQ 公共记忆库按 group:/private: 键绑定，跨机器可沿用
  没有跨机器同步：本插件只写本地 SQLite（迁移靠打包库文件）



十二、常见故障与排查


  Q: 面板里没有「跨会话记忆」或「QQ 记忆库」区块
     先确认 package.json 的 bundles 里有对应包，且目录存在
     确认 package.json 无 BOM（BOM 会让 bundle 被静默跳过）
     客户端 bundle 在 DSH 启动时加载，改完必须重启

  Q: 工具不存在（unknown tool "crossmem_stats"）
     同上：bundle 没加载。看 <DSH_HOME>/../.dsh-crossmem/boot.log：
       有 module-imported/apply-enter 说明加载了；完全没有说明没被 import

  Q: QQ 会话记不住新口令
     先 crossmem_stats 看「外部会话域」是否为 qq（没装域插件就是未安装）
     再看 QQ 会话的注入块里有没有那条（有  模型没照做；没有  没写进去）

  Q: 换了机器后记忆变少
     多半是两个插件的 dbPath 不一致，读到了两个不同的库文件

  Q: 本机会话里混进了 QQ 的内容
     检查 includeQq 是否为 true；以及 QQ 记忆行的 scope 是否被人改成了 shared


警告！！！
该插件可能导致记忆污染，请慎用！！！


十三、迁移到另一台机器


  最新迁移包（v0.3 拆分后，两个插件都在里面）：
    C:\Users\REGRESSION\Desktop\dsh-crossmem-migrate-2026-11-02-1920.zip
  （副本：D:\deepseek memory\dist\ 下同名文件）

  包内结构：
    plugin/dsh-crossmem/        核心
    plugin/dsh-crossmem-qq/     QQ 域
    config/                     状态 + 桥接配置 + 目标机器 package.json 提示
    data/memory-shared.db       长期库快照
    data/qq-memory.db           QQ 会话记忆库快照
    README-MIGRATE.md           中文迁移说明
    README-MIGRATE-en.md        英文迁移说明
    manifest.json               每个文件的 SHA-256

  关键三步：
    1) 两个包都放进 <DSH_HOME>/profiles/desktop/node_modules/
    2) profile 的 package.json：dependencies 与 dsh.profile.bundles 各加两条，
       bundles 里核心在前、dsh-crossmem-qq 在后（package.json 必须 UTF-8 无 BOM）
    3) 两个库覆盖到目标路径，再把 state.json / qq-state.json 放回 ~/.dsh-crossmem/

  注意：state/sessions.json 是机器相关的，不要从旧机器覆盖；等桥接在新机器
        跑过一次、自动生成映射之后再动面板。

  验收：crossmem_stats 应显示「外部会话域：qq」；设置页应有两个区块
        （跨会话记忆 + QQ 记忆库）。

安装命令执行：
powershell -ExecutionPolicy Bypass -File .\install-migrate.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\install-migrate.ps1
powershell -ExecutionPolicy Bypass -File .\install-migrate.ps1 -WithData

警告：可能会产生记忆污染情况！！！


