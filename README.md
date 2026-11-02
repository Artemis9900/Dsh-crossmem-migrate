# Dsh-crossmem-migrate
It allows different sessions to share a single memory—what you say in session A is immediately available in session B; passwords set in one group are recognized by other groups; but what the administrator says in private chat remains in private chat. 

Function
Automatic recording, automatic reminders, scoped management, capable control.

Principle
Only one component exists long-term: an SQLite table (memories, with fields for content, importance, source, scope, intensity). All techniques revolve around it:

Injection: Attach system-prompt/assemble hooks. Every time a prompt is assembled, the table is queried, and a few entries are selected according to "forgetting curve × importance" and inserted—without writing to disk or appending history; turning off the switch cleans it for the next round.

Extraction: Attach agent/pre-step hooks to read the last two user messages, use regex to extract facts and write them back to the table. On the QQ side, entire prompt blocks are not scanned (would capture junk); instead, the attached [Current Message Snapshot] JSON at the end is parsed, capturing only what others said.

Scope is controlled by the scope field: shared (visible to all), group id (visible within the group), qq (visible within QQ pool), own:<session> (visible only to itself)—thus "who can see it" is filtered when querying the table, no additional databases are needed.

Split into two packages: the core only recognizes the universal concept of "session + group + scope"; QQ identity mapping, public database, and password rules are in an optional QQ domain plugin, registered to the core through a five-method interface. Without it, the core only serves the current session.

Sharing a single table with other memory plugins: dsh-ebbinghaus handles "what should be forgotten" (forgetting curves, review, archiving), QQ bridge handles "what to write in", and crossmem handles "what to remind now". The shared table distinguishes sources by prefixes.

In summary: a single table stores all memories, two hooks manage "writing" and "reminding", one scope field manages "who can see it", and an optional domain plugin handles "who is QQ".
