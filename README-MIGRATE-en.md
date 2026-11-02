dsh-crossmem   Cross-Session Memory Plugin   User & Design Guide

Version : dsh-crossmem 0.3.0  +  dsh-crossmem-qq 0.1.0 (optional QQ domain plugin)
Platform: DeepSeek Harness (DSH) 0.2.x, Node >= 22
Nature  : local SQLite only, no model calls, zero API cost

1. What problem it solves


Every session in DSH is an isolated context: a rule you set in session A is unknown
to session B; something agreed in one QQ group has to be explained again in another
group or private chat.

This plugin lets all sessions on the same machine share one memory store, and:

  injects "what should be remembered" into the system prompt every turn (no asking)
  captures explicitly stated facts from conversations (zero token cost)
  controls who can see what with "scopes": local / linked groups / QQ pool / owner DM

In one line: what was said in session A is known in session B; a passphrase agreed
in one group works in the others; but what was said in the owner DM stays there.



2. The two packages (split since v0.3)


1) dsh-crossmem -- the core (required)
   Knows only generic concepts: sessions + linked groups + scopes.
     Injection : hooks system-prompt/assemble, appends a [Cross-session memory]
                 block every turn
     Capture   : hooks agent/pre-step, extracts facts heuristically
     Tools     : crossmem_search / save / switch / sessions / groups / stats / recent
     Panel     : settings section "Cross-session memory" (toggles, groups, sessions)
   It has no idea what QQ is and never reads any QQ file.

2) dsh-crossmem-qq -- the QQ domain plugin (optional)
   Install it and the core learns about the QQ bridge bot:
     Identity : resolves DSH session-xxx back to group:<id> / private:<id>
     Read     : QQ sessions inside the pool share the "qq" scope; excluded sessions
                read only their own memories
     Write    : pool member -> qq | excluded -> own:<session> | owner DM -> own:<session>
     Budget   : QQ sessions inject 8 items / 2000 chars (local: 5 / 800)
     Capture  : parses the [message snapshot] JSON appended by the bridge and
                extracts rules such as "I send X, you reply Y"
     Panel    : an extra settings section "QQ memory library", where you freely
                pick any number of conversations into the shared pool

The two cooperate through a five-method "domain interface" registered on
globalThis.__crossmemDomains:
     conversationOf(sessionId)          session -> external conversation key
     viewerOf(sessionId, ctx)           what this session may read/write/inject
     rowScope(row)                      which scope a legacy row belongs to
     captureFacts(messages)             extract facts (QQ snapshot/rule logic)
     isOwnerPrivate(conv)               is this the sink-only owner DM

To support Douyin, WeChat or another surface later, implement these five methods;
the core does not need to change.



3. The four scopes


  Scope           Who can see it                        When to use
  shared          every session                         public knowledge, local facts
  group id        only sessions in that linked group    manual grouping
  qq              QQ sessions inside the pool           sharing across QQ chats
                  (local sessions need includeQq)
  own:<session>   only that session                    owner DM (sink only),
                                                        sessions outside the pool

Resolution order (important):
  1) shared is visible to everyone
  2) own:xxx only to xxx itself (even includeQq cannot bypass it)
  3) other scopes depend on the session's readScopes (group id, qq, ...)
  4) when includeQq=true, local sessions also see external-domain memories
     (legacy switch, off by default)



4. What the injected block looks like


Local session (5 items / 800 chars max):

  [Cross-session memory - latest 5]
  [fact] The operator uses an RTX 4050 6GB; 8B models are slow (hardware)
  [task] Every night at 23:00: write diary, rewrite self-description (scheduled)
  (source: local shared library; current session 8b645252 @ project dir.
   use crossmem_search to search, crossmem_save to record.)

QQ session (8 items / 2000 chars max):

  [Cross-session memory - latest 8]
  [fact] 357 -> 9955 (verbatim: I send 357 you reply 9955) (cross-session/rule)
  [episode] Group-only stickers, a recurring joke (daily digest)
  (source: QQ group:916178625 (cross-group / cross-day continuity);
   current session 1c5e407d @ agents.
   use crossmem_search to search, crossmem_save to record.)

Ranking rules (lessons learned the hard way):
  Local: R (forgetting curve) x importance
  QQ   : half of the slots go to items written in the last 24 hours, the rest are
         filled by score
    Reason: ranking by score alone lets a brand-new passphrase lose to months-old
            importance-5 memories, so all 8 slots fill with old content and it
            looks exactly like "it does not remember across groups".
  Items learned in the same conversation get a 1.6x boost (shared across groups,
  but the group's own business is not drowned out)
  kind=slang (jargon) never enters the block; use qq_slang_query instead



5. Automatic capture (zero cost)


Local sessions: pattern-based, only explicit statements are stored:
  remember / note that / do not forget: ...
  my name is ...
  from now on use ... / follow ...
  I like / hate / dislike ...
  do not / never / forbidden ...

QQ sessions: the whole prompt is NOT scanned (that produced junk rows such as
`you</message>`); instead the [message snapshot] JSON appended by the bridge is
parsed, only messages from other people are taken, and rules are extracted:
  I send X, you reply Y / I say X, you answer Y
  X is Y / X corresponds to Y / X = Y / X -> Y
  Extracted passphrases are stored with importance 5 and the tag "rule",
  in the qq scope.

There is also optional "local model extraction at session end": when a session
ends, the buffered messages are handed to a local Ollama model to extract 1-3
facts, with no API cost. If the model is missing it degrades silently and never
blocks the session.



6. Tools


  crossmem_search   cross-session search (explicit query, no scope filtering)
  crossmem_save     write a memory (scope inferred from the current session)
  crossmem_recent   latest N items
  crossmem_stats    store overview: counts, sources, budgets, external domain,
                    linked groups, soft switches
  crossmem_sessions list local sessions (grouped by workspace, with group tags)
  crossmem_groups   linked groups: list / create / delete / add / remove
  crossmem_switch   soft switches: inject / capture (for rollback, immediate)

Provided additionally by the QQ domain plugin:
  Panel API: GET/POST /api/crossmem-qq/state and /api/crossmem-qq/pool
  Settings section "QQ memory library" (add all / clear / add one by one)



7. Configuration


Core (dsh-crossmem):

  Key               Default                                Meaning
  dbPath            ~/.dsh-ebbinghaus/memory-shared.db     shared with ebbinghaus + QQ bridge
  injectCount       5                                      local injection count
  maxInjectChars    800                                    local block char cap
  includeQq         false                                  also inject external-domain memories locally
  autoCapture       true                                   heuristic capture
  captureMinLen     6                                      minimum captured length
  captureLocal      true                                   local Ollama extraction at session end
  ollamaUrl         http://127.0.0.1:11434                 local model endpoint
  ollamaModel       modelscope.cn/Qwen/Qwen3-8B-GGUF:Q4_K_M
  curve / curveK    power / 1.5                            forgetting curve for ranking
  statePath         ~/.dsh-crossmem/state.json             soft switches + linked groups

QQ domain (dsh-crossmem-qq):

  Key               Default                                Meaning
  qqSessionsPath    auto-detected                          QQ bridge state/sessions.json
  ownerPrivate      private:617171367                       owner DM keys (comma separated): sink only
  injectCount       8                                      QQ injection count
  maxInjectChars    2000                                   QQ block char cap
  statePath         ~/.dsh-crossmem/qq-state.json          QQ pool membership (qqPool)



8. Install / uninstall


Install (manual):
  1. Copy the plugin directory to
       <DSH_HOME>/profiles/desktop/node_modules/<package-name>
  2. In the profile package.json:
       add to dependencies       "<package-name>": "file:./node_modules/<package-name>"
       add to dsh.profile.bundles "<package-name>"   (core first, qq after)
  3. Fully quit DSH, then start it again

  NOTE: package.json must be UTF-8 without a BOM. A BOM makes DSH's JSON.parse
        throw, and that bundle is then skipped silently - no error, it simply does
        not load. This is very expensive to debug.

Uninstall:
  Mute only   : set {"inject":false,"capture":false} in state.json, or run rollback.ps1
  Full removal: delete both entries (bundles + dependencies), delete the directory, restart
  QQ only     : delete the dsh-crossmem-qq entry and directory; the core falls back to
                local-only mode, and the QQ qq/own: memories automatically disappear
                from local injection (the core's safe default)



9. Where the data lives


  ~/.dsh-ebbinghaus/memory-shared.db   long-term store (shared with dsh-ebbinghaus
                                       and the QQ bridge). Table memories:
                                       content/importance/source/tags/strength/
                                       review_count/archived/scope
  ~/.dsh-crossmem/state.json           core soft switches + linked groups
  ~/.dsh-crossmem/qq-state.json        QQ pool membership (qqPool)
  <qq-bridge>/state/qq-memory.db       QQ session memory (topics/thoughts/
                                       impressions, 24h TTL)
  <qq-bridge>/state/sessions.json      QQ session map (session-xxx -> group/private)

Memories are attributed by the "source" prefix, and that convention is the key to
cross-plugin visibility:
  crossmem:dsd / crossmem:qq   written by this plugin (local / QQ)
  private:<QQ> / group:<id>    written per conversation by the QQ bridge
  digest:<date>                daily digest from the QQ bridge
  slang.json / douyin / ''     other sources



10. Relationship with dsh-ebbinghaus


Both share the same memories table (same SQLite file), but they do different jobs:

  crossmem     decides WHAT TO REMIND NOW -- injection + capture
  ebbinghaus   decides WHAT TO FORGET    -- forgetting curve, review, auto-archive
                                            (tools only, never injects)
  QQ bridge    decides WHAT TO WRITE     -- qq_recall_*, daily digest

Three real couplings; be careful when changing either side:
  1) Archiving hides rows: ebbinghaus sets archived=1, and crossmem's candidate set
     filters archived=0, so the item disappears from injection at the same moment.
  2) Reviewing changes ranking: ebb_search touches last_used_at, and crossmem's R
     also uses last_used_at, so "searched by ebbinghaus" means "fresher in crossmem".
  3) Different curves: ebbinghaus defaults to exponential, crossmem to power(k=1.5);
     the same row has different freshness in each plugin, so archiving and ranking
     can disagree.



11. Known limitations


  Not semantic search: plain SQL LIKE substring matching (only a few hundred rows,
    which is enough); deliberately no vector database
  No cwd relevance: items are chosen by scope + score, not weighted by working directory
  Local extraction degrades silently: missing model or timeout only writes a log line
  Session ids change: linked groups are bound to DSH session ids, so they must be
    re-picked after a session is rebuilt; the QQ pool is bound to group:/private:
    keys and therefore survives machine changes
  No cross-machine sync: this plugin only writes local SQLite (migration means
    packaging the database files)



12. Troubleshooting


  Q: The panel has no "Cross-session memory" or "QQ memory library" section
     First check that the bundles list in package.json contains the package and
     that its directory exists
     Check that package.json has no BOM (a BOM makes the bundle skipped silently)
     Client bundles load at DSH startup, so a restart is required after any change

  Q: Tools are missing (unknown tool "crossmem_stats")
     Same as above: the bundle did not load. Check
     <DSH_HOME>/../.dsh-crossmem/boot.log:
       if it contains module-imported/apply-enter, it loaded; if it is empty,
       the module was never imported

  Q: A QQ session does not remember a new passphrase
     Run crossmem_stats and check whether "external domain" is qq (it says
     "not installed" when the domain plugin is missing)
     Then check whether that item is present in the QQ session's injected block
     (present = the model ignored it; absent = it was never written)

  Q: Fewer memories after moving to another machine
     Almost always two different dbPath values, i.e. two different database files

  Q: QQ content leaks into local sessions
     Check whether includeQq is true; and whether a QQ row's scope was manually
     changed to shared


WARNING!!!
This plugin may cause memory pollution. Use with caution!!!


13. Migrating to another machine


  Latest migration bundle (post-split; contains BOTH packages):
    C:\Users\REGRESSION\Desktop\dsh-crossmem-migrate-2026-11-02-1920.zip
  (mirror: the same file under D:\deepseek memory\dist\)

  Bundle layout:
    plugin/dsh-crossmem/        core
    plugin/dsh-crossmem-qq/     QQ domain
    config/                     state + bridge config + target package.json hints
    data/memory-shared.db       long-term store snapshot
    data/qq-memory.db           QQ session memory snapshot
    README-MIGRATE.md           migration guide (Chinese)
    README-MIGRATE-en.md        migration guide (English)
    manifest.json               SHA-256 of every file

  Three key steps:
    1) Copy BOTH packages into <DSH_HOME>/profiles/desktop/node_modules/
    2) In the profile package.json add both entries to "dependencies" and to
       "dsh.profile.bundles"; core first, dsh-crossmem-qq after.
       (package.json must be UTF-8 without a BOM)
    3) Copy the two databases to their destinations, then restore
       state.json / qq-state.json into ~/.dsh-crossmem/

  Note: state/sessions.json is machine-specific. Do not copy it from the old
        machine; let the QQ bridge generate it on first start, then use the panel.

  Verify: crossmem_stats should report "external domain: qq", and the settings
          page should show two sections (Cross-session memory + QQ memory library).

WARNING: memory pollution may occur!!!
