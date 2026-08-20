/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the CodeGraph MCP server.
 */
import type CodeGraph from '../index';
import type { QueryPool } from './query-pool';
export declare function __setLoadCodeGraphForTests(cls: typeof import('../index').default | null): void;
import type { PendingFile } from '../sync';
import { ExploreSessionState, type ExploreEmission } from './explore-session-state';
/**
 * An expected, recoverable "codegraph can't serve this" condition — most
 * importantly a project with no index. The dispatch catch converts these to
 * SUCCESS-shaped responses (guidance text, NO isError): an `isError: true`
 * early in a session teaches the agent the toolset is broken and it stops
 * calling codegraph entirely (observed repeatedly), which is exactly wrong
 * for conditions the agent can simply work around (use built-in tools for
 * that codebase / pass projectPath). isError is reserved for "stop trying"
 * cases: security refusals ({@link PathRefusalError}) and genuine
 * malfunctions.
 */
export declare class NotIndexedError extends Error {
}
/**
 * A security refusal (sensitive system path). Stays `isError: true` WITHOUT
 * retry guidance — abandoning this path is the desired agent reaction.
 */
export declare class PathRefusalError extends Error {
}
/**
 * Normalize Erlang-native symbol spellings in an explore query into the shapes
 * the rest of the pipeline already understands. Agents working Erlang code
 * name symbols the way the language spells them — `mod:fn/3`, `init/2` — and
 * those tokens previously died in both consumers: the flow-builder's token
 * filter rejects `:` and `/arity` outright, and the search-side field parser
 * eats `mod:fn` as an unknown `field:value`. Measured on cowboy: the agent
 * named `cowboy_stream_h:request_process/3` in two queries, got no body back
 * either time, and fell back to Read.
 *
 *   - `fn/3` → `fn` (arity tail after an identifier; a path segment like
 *     `src/2fa` doesn't match because the tail must be all digits)
 *   - `mod:fn` → `mod.fn` (exactly one colon between identifiers, so it rides
 *     the existing Class.method qualified handling; `::`, URLs, drive letters,
 *     and times don't match, and the query language's own field prefixes —
 *     kind:/lang:/language:/path:/name: — are left alone)
 *
 * Safe cross-language: Lua's `t:m` spelling maps to the same `t.m` its
 * qualified names use, and no other supported spelling contains a bare
 * single-colon identifier pair.
 */
export declare function normalizeQuerySpelling(query: string): string;
/**
 * Calculate the recommended number of codegraph_explore calls based on project size.
 * Larger codebases need more exploration calls to cover their surface area,
 * but smaller ones should use fewer to avoid unnecessary overhead.
 */
export declare function getExploreBudget(fileCount: number): number;
/**
 * Adaptive output budget for `codegraph_explore`, scaled to project size.
 *
 * Smaller codebases get a tighter total cap, fewer default files, smaller
 * per-file cap, and tighter clustering — so a focused query on a 100-file
 * project doesn't dump a whole file's worth of source into the agent's
 * context. Larger codebases keep the generous defaults because the
 * agent's native discovery cost (grep + find + many Reads) genuinely
 * dwarfs a fat explore call at that scale.
 *
 * Meta-text (relationships map, "additional relevant files" list,
 * completeness signal, budget note) is gated off for tiny projects
 * where one rich call is the whole story and the extra prose is just
 * overhead.
 *
 * Tier breakpoints mirror `getExploreBudget` so a project sits in the
 * same tier across both knobs.
 */
export interface ExploreOutputBudget {
    /** Hard cap on total output characters. */
    maxOutputChars: number;
    /** Default `maxFiles` when the caller didn't specify one. */
    defaultMaxFiles: number;
    /** Cap on contiguous source returned per file (across all its clusters). */
    maxCharsPerFile: number;
    /** Cluster gap threshold in lines — tighter clustering on small projects. */
    gapThreshold: number;
    /** Max symbols listed in the per-file header (``**`path`** — sym(kind), ...``). */
    maxSymbolsInFileHeader: number;
    /** Max edges shown per relationship kind in the Relationships section. */
    maxEdgesPerRelationshipKind: number;
    /** Include the "Relationships" section. */
    includeRelationships: boolean;
    /** Include the "Additional relevant files (not shown)" trailing list. */
    includeAdditionalFiles: boolean;
    /** Include the "Complete source code is included above…" reminder. */
    includeCompletenessSignal: boolean;
    /** Include the explore-budget reminder at the end. */
    includeBudgetNote: boolean;
}
export declare function getExploreOutputBudget(fileCount: number): ExploreOutputBudget;
/**
 * How strongly a match on a symbol of this kind corroborates that its FILE is
 * what the query is about.
 *
 *   1.0   a callable or a type — the unit an architecture question is about
 *   ~0.5  a member of a type, or the file node itself (a path match, not a
 *         symbol match)
 *   ~0.3  a variable / constant — as often a name collision as a definition
 *   0.15  a parameter — essentially never the subject of a question
 *
 * Unlisted kinds fall back to `DEFAULT_RELEVANCE_KIND_WEIGHT`, so a NodeKind
 * added later is neither free nor fatal.
 */
export declare const RELEVANCE_KIND_WEIGHT: Readonly<Record<string, number>>;
export declare const EXPLORE_ALLOCATION: {
    /**
     * A file whose weight is under this fraction of the top file's gets no source.
     *
     * Calibrated between the two shapes the fixtures pin: the #1500 generated CRUD
     * lands at 10–11% of the top weight (penalised twice — once into the score by
     * `rankPenalty`, once again here) and must cliff; a genuinely peripheral but
     * hand-written flow file — `payslip_builder.go`, the direct callee of the
     * workflow entry — lands at 25% and must NOT. Everything in between is a
     * judgement call the agent can undo for ~0 cost, because a cliffed file is
     * still NAMED in the response and one follow-up explore fetches it.
     */
    readonly CLIFF_FRACTION: 0.15;
    /**
     * Ceiling on the cliff, in the same units as `SCORE_FLOOR_MAX` — and for the
     * same reason. A file whose weight clears a full-strength direct match is never
     * incidental, so no amount of concentration elsewhere may zero it: one
     * overwhelming top file (a 99-scoring god-file among score-10 peers) otherwise
     * puts the cliff at 14.9 and silences every peer the score floor had just
     * deliberately admitted. The cliff is a RELATIVE prune of weak evidence, not a
     * second admission gate — the score floor already owns admission.
     */
    readonly CLIFF_MAX: 10;
    /**
     * Floor on a useful reservation — every admitted file gets this much before
     * the proportional split divides the rest. Under it a slice can't hold one
     * complete method, and a fragment is strictly worse than a pointer: it forces
     * the Read this tool exists to prevent.
     *
     * It is a FLOOR, not a second cliff. Cliffing the starved file instead
     * cascades: removing the smallest raises everyone else's share by so little
     * that the next-smallest starves too, and a query with two dominant files ate
     * six legitimately-ranked peers one at a time. Concentration is the relative
     * cliff's job; this only keeps a served file's slice usable.
     */
    readonly MIN_CHARS: 700;
    /**
     * Safety valve, as a fraction of the envelope. Not the primary guard any more —
     * the proportional split is — so this only has to stop a pathological
     * single-file response.
     */
    readonly MAX_SHARE: 0.7;
    /**
     * Markdown overhead charged per rendered file (header + fences + blank lines),
     * matching the render loop's own `+ 200` accounting. Held out of the pool
     * before the split so the reservations plus their overhead fit the envelope —
     * without this the last file's reservation is always the one that doesn't fit.
     */
    readonly FILE_OVERHEAD: 200;
    /**
     * Flow-spine files are weighted up and are exempt from the cliff. Clipping the
     * spine causes the Read fallback (it IS the answer to a flow question);
     * clipping a peripheral file does not. This makes the existing advisory spine
     * handling — `hasSpine`, `SPINE_CEILING` — strict at the allocation layer.
     */
    readonly SPINE_WEIGHT_BOOST: 2;
    /**
     * Slack allowed on the whole-file rule: a file a little over its reservation
     * still ships WHOLE rather than as clusters, because slicing off that last
     * sliver saves ~1% of the envelope and costs a Read — the trade the whole-file
     * rule exists to refuse. Proportional (with an absolute ceiling) because a
     * "sliver" is relative: a flat 800 is 15% of a 5K reservation but 31% of a 2.5K
     * one, and at the small end that overshoot is exactly what the file below then
     * loses.
     */
    readonly WHOLE_FILE_GRACE_FRACTION: 0.15;
    readonly WHOLE_FILE_GRACE_MAX: 800;
    /**
     * A reservation that already covers this fraction of a file BUYS THE WHOLE
     * FILE (CG-21), even though the file is bigger than the reservation.
     *
     * The grace above is calibrated as a *sliver* — it only rescues a file that
     * essentially fits. Below it there is a hole the render loop cannot fill:
     * express's `lib/utils.js` (5,293 B) was the TOP-ranked file, reserved 3,870,
     * declined the whole-file render at a 4,450 grace bound, and then spent 583 on
     * a three-symbol cluster render. The other 3,287 chars of its reservation were
     * neither redistributed nor delivered — the envelope shrank by a third against
     * an unchanged budget and the agent Read the file back four times.
     *
     * So the rule is not "does the file fit the reservation" but "has the
     * reservation already bought most of the file": at 0.6 the loop pays at most
     * two-thirds of a reservation extra to avoid losing the whole thing, and it
     * spends bytes it was going to spend anyway on a file that already earned
     * them. Below the fraction the shortfall is real — the file is several times
     * its reservation, clustering is the right answer, and the carry-forward
     * (`reservedSoFar`/`sourceSpent` in the render loop) hands whatever it cannot
     * spend to the next file down.
     */
    readonly WHOLE_FILE_BUY_FRACTION: 0.6;
    /**
     * The buy rule's overshoot is funded from ONE pool for the whole response,
     * sized as this fraction of the envelope — deliberately the same 15% as
     * `WHOLE_FILE_GRACE_FRACTION`, one level up: the grace is a sliver of a
     * FILE's reservation, this is a sliver of the RESPONSE's envelope.
     *
     * Per-file funding is the version that fails, and it fails the same way the
     * bug being fixed does. The merit test is a RATIO, so wherever several files
     * sit near it they all qualify, and N independent overshoots inflate the
     * response until the render ceiling drops whatever is last. Measured on the
     * #1500 payroll fixture: three files bought whole and `payslip_builder.go` —
     * the file that computes the payslip the question asks about, rank #6 — was
     * dropped entirely so three higher-ranked files could each ship their final
     * sliver. A dropped section is strictly worse than a clustered one, so one
     * shared pool, spent in rank order, is the bound that matters.
     */
    readonly WHOLE_FILE_BUY_OVERSHOOT_FRACTION: 0.15;
};
/** One candidate file's allocation inputs, in final rank order. */
export interface ExploreAllocationCandidate {
    path: string;
    /** Post-`rankPenalty` relevance score from the ranking pass. */
    score: number;
    /**
     * How much this file's BYTES are worth, independent of how well it matched.
     * Ranking answers "is this file about the query"; allocation answers "will
     * these bytes teach the agent anything". Generated CRUD can legitimately rank
     * (it name-collides on every domain word) while its bytes stay mechanical
     * boilerplate the agent gains nothing from reading — so `rankPenalty` is
     * applied a SECOND time here. That is what finally sinks the #1500 generated
     * layer below the cliff: it survived CG-10's single penalty because the sort's
     * leading keys (entry-point, graph mass) are structural, and a big densely
     * self-referential generated file scores well on both.
     */
    worth: number;
    /** Carries a symbol on the rendered flow spine. */
    spine: boolean;
}
export interface ExploreAllocation {
    /** path → chars of source it may render. Only holds admitted files. */
    allowances: Map<string, number>;
    /** Files the cliff zeroed, in rank order — pointers, not bytes. */
    cliffed: string[];
    /** The weight threshold the cliff fired at (0 when nothing was cliffed). */
    cliffAt: number;
    /** Chars actually split among the admitted files. */
    pool: number;
}
/**
 * Split `budget.maxOutputChars` across ranked candidates in proportion to
 * relevance, with a hard relative cliff.
 *
 * `candidates` must arrive in FINAL RANK ORDER — `maxFiles` is applied to the
 * survivors of the cliff, in that order, so cliffing genuinely hands a slot to
 * the next file down rather than leaving it unused.
 *
 * Tier invariant (`getExploreOutputBudget`): a larger tier must never allow less
 * per file than a smaller one. It holds here by construction — every bound is a
 * fraction of `maxOutputChars` or of `maxCharsPerFile`, both monotonic across
 * tiers — except `MIN_CHARS`, which is an absolute floor and so identical at
 * every tier.
 */
export declare function allocateExploreBudget(candidates: readonly ExploreAllocationCandidate[], budget: ExploreOutputBudget, maxFiles: number): ExploreAllocation;
/**
 * Per-file staleness banner emitted at the top of a tool response when the
 * file watcher has pending events for files referenced by the response.
 * The agent uses this to fall back to Read for those specific files
 * without waiting for the debounced sync (issue #403).
 */
export declare function formatStaleBanner(stale: PendingFile[]): string;
/**
 * Compact footer listing pending files that are NOT referenced in this
 * response. Gives the agent a complete project-wide freshness picture
 * without bloating the main banner.
 */
export declare function formatStaleFooter(stale: PendingFile[]): string;
/**
 * Whole-index degradation banner (issue #876). Emitted at the top of a read
 * tool response when live watching has permanently stopped — at which point
 * `getPendingFiles()` is empty, so the per-file banner above can't fire even
 * though the index is now FROZEN and silently drifting stale. Leads with the
 * agent-actionable instruction (Read directly) and carries the reason, which
 * already names the operator remedy (`codegraph sync` / git hooks).
 */
export declare function formatDegradedBanner(reason: string | null): string;
/**
 * MCP Tool definition
 */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, PropertySchema>;
        required?: string[];
    };
    /** Behavioral hints for clients (see {@link ToolAnnotations}). */
    annotations?: ToolAnnotations;
}
/**
 * MCP ToolAnnotations — behavioral hints a client MAY use to decide how, or
 * whether, to run a tool (introduced in the 2025-03-26 spec, carried in
 * 2025-06-18). They are advisory and never to be trusted for security, but
 * clients gate on them: Cursor's Ask mode, for one, refuses any MCP tool that
 * doesn't advertise `readOnlyHint: true` (issue #1018).
 *
 * The field is purely additive — a client that predates annotations ignores it
 * — so codegraph advertises these even though `initialize` still negotiates the
 * 2024-11-05 protocol version.
 *
 * https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations
 */
export interface ToolAnnotations {
    /** Human-readable title for the tool. */
    title?: string;
    /** If true, the tool does not modify its environment. Default (unset): false. */
    readOnlyHint?: boolean;
    /** Meaningful only when NOT read-only: may the tool perform destructive updates? */
    destructiveHint?: boolean;
    /** If true, repeat calls with the same arguments have no additional effect. */
    idempotentHint?: boolean;
    /** If true, the tool interacts with an open world of external entities. */
    openWorldHint?: boolean;
}
interface PropertySchema {
    type: string;
    description: string;
    enum?: string[];
    default?: unknown;
}
/**
 * Tool execution result
 */
export interface ToolResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
    /**
     * INTERNAL side-channel (CG-17): what a `codegraph_explore` call actually put
     * on the wire — files, line ranges, bytes. It rides the result because the
     * call may have run on a query-pool worker, while the session state it feeds
     * lives on the main thread. {@link ToolHandler.execute} records it and DELETES
     * it, so nothing here ever reaches the client. Keyed by
     * {@link EXPLORE_EMISSION_KEY}; the two must stay in sync.
     */
    _cgExploreEmission?: ExploreEmission;
}
/**
 * All CodeGraph MCP tools
 *
 * Designed for minimal context usage - use codegraph_explore as the primary tool
 * (one call usually answers the whole question), and only use other tools for
 * targeted follow-up queries.
 *
 * All tools support cross-project queries via the optional `projectPath` parameter.
 */
export declare const tools: ToolDefinition[];
/**
 * Allowlist-filtered tool definitions WITHOUT an engine — the static surface the
 * proxy answers `tools/list` with before any project is open. Mirrors
 * `ToolHandler.getTools()` in the no-CodeGraph case (the dynamic per-repo budget
 * note in a description only adds once `cg` is loaded; the schemas are static).
 */
export declare function getStaticTools(): ToolDefinition[];
/**
 * Tool handler that executes tools against a CodeGraph instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export declare class ToolHandler {
    private cg;
    private projectCache;
    private defaultProjectHint;
    private worktreeMismatchCache;
    private catchUpGate;
    private queryPool;
    constructor(cg: CodeGraph | null);
    /**
     * Engine-only: attach (or detach with null) the worker-thread query pool. The
     * shared daemon sets this once its default project is open; the workers each
     * hold their own WAL read connection and run {@link executeReadTool}. A
     * worker's own ToolHandler never has a pool, so there is no nested off-loading.
     */
    setQueryPool(pool: QueryPool | null): void;
    /**
     * Update the default CodeGraph instance (e.g. after lazy initialization)
     */
    setDefaultCodeGraph(cg: CodeGraph): void;
    /**
     * Engine-only: register the catch-up sync promise so the next `execute()`
     * call awaits it before serving. The handler swallows rejections (the
     * engine logs them) so a sync failure never propagates as a tool error;
     * we still want to serve a best-effort result over the same potentially-
     * stale data, which is what would have happened without the gate.
     */
    setCatchUpGate(p: Promise<void> | null): void;
    /**
     * Await the catch-up gate, but no longer than the configured timeout (#905).
     * If the reconcile settles first, we got the fully-reconciled answer. If the
     * timeout wins, we serve the call now and let the reconcile finish in the
     * background — it yields to the event loop (see SYNC_RECONCILE_YIELD_INTERVAL),
     * so a concurrent read still runs against the same connection. Never throws:
     * a failed reconcile is logged by the engine, and we serve best-effort over
     * the same potentially-stale data the un-gated path would have.
     */
    private awaitCatchUpGate;
    /**
     * Record the directory the server tried to resolve the default project from.
     * Used only to make the "no default project" error actionable.
     */
    setDefaultProjectHint(searchedPath: string): void;
    /**
     * Whether a default CodeGraph instance is available
     */
    hasDefaultCodeGraph(): boolean;
    /**
     * Optional allowlist of exposed tools, parsed from the CODEGRAPH_MCP_TOOLS
     * env var (comma-separated short names, e.g. "trace,search,node,context").
     * Unset/empty → every tool is exposed. Lets an operator (or an A/B harness)
     * trim the tool surface without rebuilding the client config; the ablated
     * tool is then truly absent from ListTools rather than merely denied on call.
     * Matching is on the short form, so "node" and "codegraph_node" both work.
     */
    private toolAllowlist;
    /** Whether a tool name passes the CODEGRAPH_MCP_TOOLS allowlist (if any). */
    private isToolAllowed;
    /**
     * Get tool definitions with dynamic descriptions based on project size.
     * The codegraph_explore tool description includes a budget recommendation
     * scaled to the number of indexed files. Honors the CODEGRAPH_MCP_TOOLS
     * allowlist so a trimmed surface is reflected in ListTools.
     */
    getTools(): ToolDefinition[];
    /**
     * Get CodeGraph instance for a project
     *
     * If projectPath is provided, opens that project's CodeGraph (cached).
     * Otherwise returns the default CodeGraph instance.
     *
     * Walks up parent directories to find the nearest .codegraph/ folder,
     * similar to how git finds .git/ directories.
     */
    private getCodeGraph;
    /**
     * Heal a long-lived connection whose `.codegraph/` was removed and recreated
     * at the same path (a worktree recreated, or `rm -rf .codegraph` + re-init)
     * before handing it to a tool. Otherwise the daemon keeps serving the
     * pre-removal snapshot from its now-unlinked file handle until restart — and
     * because the daemon registry is keyed by path, a same-path recreate routes
     * new clients straight back to this same stale daemon (#925). The check is one
     * stat() and a no-op unless the inode actually changed; it never throws into a
     * tool call.
     */
    private freshen;
    /**
     * Close all cached project connections
     */
    closeAll(): void;
    /**
     * Validate that a value is a non-empty string within length bounds.
     *
     * The `maxLength` cap protects against MCP clients that ship huge
     * payloads (10MB+ query strings either by accident or maliciously).
     * Without this, a single oversized input can pin the FTS5 index or
     * exhaust memory before any real work runs.
     */
    private validateString;
    /**
     * Validate an optional path-like string input. Returns the value if
     * valid (or undefined), or a ToolResult with the error.
     */
    private validateOptionalPath;
    /**
     * Cached git worktree/index mismatch for a tool call's effective project.
     *
     * The "effective project" is what the request targets: an explicit
     * `projectPath` arg, else the directory the server resolved its default
     * project from (`defaultProjectHint`), else cwd. Memoized per start path —
     * see `worktreeMismatchCache`. Best-effort: if the project can't be resolved
     * (e.g. nothing initialized yet), it reports "no mismatch" so a tool is never
     * broken by this check.
     */
    private worktreeMismatchFor;
    /**
     * Prefix a successful read-tool result with a compact worktree-mismatch
     * notice when the resolved index belongs to a different git working tree than
     * the caller's (issue #155). Without this, an agent in a nested worktree
     * silently trusts main-branch results. No-op on error results and when there
     * is no mismatch. `codegraph_status` is excluded — it embeds its own verbose
     * warning — so it stays out of this path.
     */
    private withWorktreeNotice;
    /**
     * Annotate a successful read-tool result with per-file staleness — the
     * non-blocking answer to issue #403. The file watcher tracks every event
     * it sees per path; here we intersect "files referenced in this response"
     * against that pending set and prepend a compact banner so the agent can
     * fall back to Read for those *specific* files without waiting for the
     * debounced sync to fire. Other pending files in the project (not
     * referenced by this response) get a small footer so the agent has a
     * complete picture without bloating the banner.
     *
     * Cost when nothing is pending — the common case — is one boolean check.
     * No I/O, no parsing of markdown beyond a per-pending-file substring scan.
     */
    private driftCache;
    private static readonly DRIFT_TTL_MS;
    /**
     * On-disk drift check for a single indexed file (issue #1474). The code
     * renderers slice CURRENT bytes at INDEXED line ranges; when the file
     * changed after its last index sync those ranges can point at a DIFFERENT
     * symbol's code — served under the requested name with `isError: false`.
     * The watcher-based pending/degraded banners can't cover this for a
     * project reached via `projectPath` (cross-project instances have no
     * watcher, by construction), so freshness is verified here, at the point
     * of emission, from data the index already stores.
     *
     * Cheap and precise: one stat() per file (size + mtime, the same
     * comparison the sync fast path uses); only on a stat mismatch is the
     * content hashed (sha256, matching extraction's `hashContent`) so a
     * touch/checkout that rewrote identical bytes never false-positives.
     * Results are memoized briefly so one response rendering the same file in
     * several sections pays for the check once.
     *
     * Returns true when the on-disk file differs from what was indexed —
     * i.e. indexed line ranges for it are NOT trustworthy. Any failure
     * (missing files-table row, stat/read error) reports false: those cases
     * are handled by the existing not-found paths, and a wrong "stale" flag
     * would needlessly push the agent back to Read.
     */
    private isFileStaleOnDisk;
    private withStalenessNotice;
    /**
     * Execute a tool by name.
     *
     * `sessionState` is the CALLER's per-session explore history (CG-17). The
     * daemon shares one ToolHandler across every connected session, so this state
     * cannot live on the handler — each session owns one and hands it in, which is
     * what keeps two sessions on one daemon from ever seeing each other's calls.
     * Omit it (the CLI does) and explore behaves exactly as before, untracked.
     */
    execute(toolName: string, args: Record<string, unknown>, sessionState?: ExploreSessionState): Promise<ToolResult>;
    /**
     * Attach the caller's session view to an explore call's args (CG-17), on a
     * COPY so the caller's object is never mutated. Nothing else sees it: a
     * non-explore tool, or a caller with no session state, gets the args
     * unchanged and pays nothing.
     *
     * A client that spells the internal key itself is stripped rather than
     * trusted — the view decides what source a later call may withhold, so it has
     * to come from the server's own record, never from the wire.
     */
    private withSessionView;
    /**
     * Record an explore call's emission into the caller's session state and strip
     * it from the result (CG-17).
     *
     * Unconditional strip: the property is internal, so it comes off even when
     * there is no session state to record it into (the CLI path) — that is what
     * keeps the agent-facing response byte-identical. Recording is wrapped
     * because a bookkeeping bug must never fail a tool call that already
     * succeeded.
     */
    private takeExploreEmission;
    /**
     * Run a single read tool to completion and return its raw {@link ToolResult},
     * classifying expected failures the same way {@link execute}'s catch does so
     * the SHAPE is identical whether dispatch runs in-process or on a worker:
     * NotIndexed → success-shaped guidance, PathRefusal → clean error, anything
     * else → internal-error-with-retry. Never throws.
     *
     * This is the worker thread's entry point (see {@link ./query-worker}) and the
     * in-process fallback for {@link execute}. It deliberately does NOT run the
     * catch-up gate or the staleness/worktree notices — those need the daemon's
     * watched main instance and stay on the main thread. Cross-cutting allowlist +
     * path validation already ran in {@link execute} before routing here.
     */
    executeReadTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
    /**
     * Pure dispatch over the read tools — the switch, with no gate, no notices, no
     * allowlist/validation (the caller owns those). `codegraph_status` is handled
     * on the main thread in {@link execute} and never reaches here. May throw
     * NotIndexed/PathRefusal, which {@link executeReadTool} classifies.
     */
    private dispatchTool;
    /**
     * Handle codegraph_search
     */
    private handleSearch;
    /**
     * Group symbol matches into DISTINCT DEFINITIONS — one group per
     * (filePath, qualifiedName), so same-file overloads stay together while
     * unrelated same-named classes across a monorepo's apps (#764: one
     * `UserService` per NestJS app) are kept apart. Optionally narrowed by a
     * `file` path/suffix first.
     */
    private groupDefinitions;
    /** Section heading for one distinct definition in grouped output. */
    private definitionHeading;
    /**
     * Handle codegraph_callers
     */
    private handleCallers;
    /**
     * Handle codegraph_callees
     */
    private handleCallees;
    /**
     * Handle codegraph_impact
     */
    private handleImpact;
    /**
     * Describe a synthesized (dynamic-dispatch) edge for human output: how the
     * callback was wired up — the bridge static parsing can't see. Returns null
     * for ordinary static edges. Used by trace + the node trail so a synthesized
     * hop reads as "registered via onUpdate at App.tsx:3148", not a bare arrow.
     */
    private synthEdgeNote;
    /**
     * Flow-from-named-symbols: an agent's codegraph_explore query is a bag of
     * symbol names that usually spans the flow it's investigating (e.g.
     * "PmsProductController getList PmsProductService list PmsProductServiceImpl").
     * Surface the longest call chain AMONG those named symbols — scoped to what the
     * agent explicitly named, so (unlike a fuzzy relevance set) there's no
     * wrong-feature wandering. Rides synthesized edges, so controller→service-
     * interface→impl shows up. Returns '' if no chain of >=3 nodes exists.
     *
     * Ambiguous tokens (Java `list` → dozens of nodes) are disambiguated by
     * CO-NAMING: the agent names the class too, so we keep only `list` candidates
     * whose qualifiedName contains another named token (`PmsProductServiceImpl::list`),
     * dropping unrelated `OmsOrderService::list`.
     */
    private buildFlowFromNamedSymbols;
    /**
     * Dynamic-boundary surfacing (#687): when the flow among the agent's named
     * symbols does not fully connect, scan the disconnected symbols' bodies for
     * dynamic-dispatch sites (computed member calls, getattr, reflection, typed
     * message buses, runtime-keyed emits) and ANNOUNCE the boundary — the exact
     * site, the form, and (when a key is statically visible) candidate targets —
     * instead of guessing edges. The answer to "how does A reach B" when no
     * static path exists IS the dispatch site: that's where the flow continues
     * at runtime. Query-time, deterministic, zero graph mutation; a fully
     * connected flow never reaches this method.
     */
    private buildDynamicBoundaries;
    /**
     * Interface/registry-dispatch announcement — #687 extended to GRAPH-visible
     * polymorphism (the body-scan can't see it: `nodeType.execute()` is textually
     * an ordinary call; the polymorphism lives in the `implements`/`extends` edges).
     *
     * A method the agent named that resolves to a large same-name family whose
     * definers overwhelmingly implement/extend ONE supertype is a runtime dispatch:
     * the concrete target is chosen at runtime from N implementations, so no single
     * static edge is "the answer" — the implementations ARE the continuations. We
     * announce the supertype, its TRUE implementer count, and a few concrete targets,
     * then steer to codegraph_explore. Graph-only, query-time, zero mutation; the
     * caller fires it ONLY for an UNCOVERED named token, so a connected flow is silent.
     *
     * Robust to FTS sampling bias: the same-name family is a capped FTS sample that
     * over-represents whatever FTS ranks first (n8n: DB `TableOperation.execute`
     * outnumbered `INodeType.execute` in the sample 7:6 even though INodeType has
     * 611 implementers vs a handful). So candidate supertypes are ranked by their
     * TRUE graph-wide implementer count, NOT their frequency in the sample.
     */
    private buildPolymorphicBoundaries;
    /**
     * Shortlist candidate runtime targets for a dispatch key surfaced by
     * {@link buildDynamicBoundaries}. Exact conventional names first (`save` →
     * `onSave`/`handleSave`; `CreateCmd` → `CreateCmdHandler`), then FTS, with a
     * normalized-containment post-filter (FTS camel-splitting is fuzzier than a
     * candidate list should be). Symbols the agent already named sort first and
     * are marked — that's the "you were right, here's the wiring" case.
     */
    private boundaryCandidates;
    /**
     * Compact "blast radius" for the entry symbols of an explore result: who
     * depends on each (callers) and which test files cover it — LOCATIONS ONLY,
     * no source, so the agent knows what to update / re-verify before editing
     * without reaching for a separate impact call. Always-on, but skips symbols
     * that have no dependents (nothing to warn about), and returns '' when none
     * qualify so a leaf-only exploration stays clean.
     */
    private buildBlastRadiusSection;
    /**
     * Test-coverage note for a blast-radius entry whose DIRECT callers include no
     * test file. A helper called only by production code can still be exercised
     * by tests further up the caller chain (#1475: 40% of directly-unflagged
     * symbols had a test within 2-3 hops), so walk up to 2 more hops before
     * claiming anything — and even then claim only what was measured.
     */
    private indirectTestNote;
    /**
     * Graph-connectivity relevance via Random-Walk-with-Restart (personalized
     * PageRank) from the query's matched SEED nodes over the call/reference graph.
     *
     * This is the ranking signal text search (FTS/bm25) CANNOT provide, and it's
     * codegraph's home turf: relevance by STRUCTURE, not words. A file whose
     * symbols are call-connected to the matched cluster accrues walk mass and
     * ranks high; a lone TEXT match — e.g. `LensSwitcher.swift` matched the word
     * "switch" from `switchOrganization`, but calls none of `setUser`/`fetchUser`
     * — gets only its own restart probability and ranks ~0. Immune to the
     * tokenization trap that fools term matching, deterministic, no embeddings.
     *
     * Undirected adjacency (reachability both ways), restart α=0.25 to the seeds,
     * power iteration to convergence. Bounded to the already-relevant subgraph, so
     * it's a few hundred nodes × ~25 iterations — negligible cost.
     */
    private computeGraphRelevance;
    /**
     * Handle codegraph_explore — deep exploration in a single call
     *
     * Strategy: find relevant symbols via graph traversal, group by file,
     * then read contiguous file sections covering all symbols per file.
     * This replaces multiple codegraph_node + Read calls.
     *
     * Output size is adaptive to project file count via
     * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
     * tax on small projects while earning its keep on large ones.
     */
    private handleExplore;
    /**
     * An explore response plus the record of what it emitted (CG-17). The record
     * rides the result only as far as {@link execute}, which files it into the
     * calling session's state and deletes it — see {@link EXPLORE_EMISSION_KEY}.
     */
    private exploreResult;
    /**
     * Handle codegraph_node
     */
    private handleNode;
    /**
     * FILE READ MODE: resolve `fileArg` (path or basename) to an indexed file and
     * read it like the Read tool — its current on-disk source with line numbers,
     * narrowable with `offset`/`limit` exactly as Read's are — preceded by a
     * one-line blast-radius header (which files depend on it). `symbolsOnly`
     * returns just the structural map (symbols + dependents) instead of source.
     *
     * Parity goal: the numbered source block is byte-for-byte the shape Read
     * returns (`<n>\t<line>`, no padding), so the agent treats it as a Read — only
     * faster (served from the index) and with the blast radius attached. Security:
     * yaml/properties files are summarized by key, never dumped (#383); reads go
     * through validatePathWithinRoot (#527).
     */
    private handleFileView;
    /** Render one symbol: details + (optional) body/outline + its caller/callee trail. */
    private renderNodeSection;
    private static readonly STALE_WHOLE_FILE_MAX_LINES;
    private static readonly STALE_WHOLE_FILE_MAX_CHARS;
    /**
     * codegraph_node render for a symbol whose file changed on disk after the
     * last index sync (issue #1474). The indexed line range is no longer
     * trustworthy, so no slice is emitted: a small file gets its full CURRENT
     * source (Read-parity — sufficiency preserved, the agent still doesn't need
     * Read); a large one gets an explicit notice steering to the tool's own
     * file-read mode (or Read) — honest absence instead of confident wrongness.
     * Location/signature stay (they're the index's answer) but are flagged as
     * possibly shifted.
     */
    private renderStaleNodeSection;
    /**
     * Build the "trail" for a symbol: its direct callees (what it calls) and
     * callers (what calls it), each with file:line — so codegraph_node doubles as
     * the structural Grep→Read→expand primitive: a spot PLUS where to go next.
     * Capped to stay cheap. Walk the graph by calling codegraph_node on a trail
     * entry; no Read needed for covered hops. Empty edges on a non-leaf often mean
     * dynamic dispatch the static graph couldn't resolve — that absence is itself
     * a signal (read that one hop) rather than a dead end.
     */
    private formatTrail;
    /**
     * Handle codegraph_status
     */
    private handleStatus;
    /**
     * Handle codegraph_files - get project file structure from the index
     */
    private handleFiles;
    /**
     * Convert glob pattern to regex
     */
    private globToRegex;
    /**
     * Format files as a flat list
     */
    private formatFilesFlat;
    /**
     * Format files grouped by language
     */
    private formatFilesGrouped;
    /**
     * Format files as a tree structure
     */
    private formatFilesTree;
    /**
     * Find a symbol by name, handling disambiguation when multiple matches exist.
     * Returns the best match and a note about alternatives if any.
     */
    /**
     * Check if a node matches a symbol query.
     *
     * Accepts simple names (`run`) and three flavors of qualifier:
     *   - dotted     `Session.request`         (TS/JS/Python)
     *   - colon-pair `stage_apply::run`        (Rust, C++, Ruby)
     *   - slash      `configurator/stage_apply` (path-ish)
     *
     * Multi-level qualifiers compose: `crate::configurator::stage_apply::run`
     * works. Rust path prefixes (`crate`, `super`, `self`) are stripped so
     * the canonical `crate::module::symbol` form resolves.
     *
     * Resolution order, last part must always equal `node.name`:
     *   1. Suffix-match against `qualifiedName` (handles class-scoped methods
     *      where the extractor builds the qualified name from the AST stack)
     *   2. File-path containment (handles file-derived modules in Rust/
     *      Python — `stage_apply::run` matches a `run` in `stage_apply.rs`)
     */
    private matchesSymbol;
    /**
     * Find ALL definitions matching a name, ranked, so codegraph_node can return
     * every overload instead of guessing one (the wrong guess → a Read). Keepers
     * rank before generated stubs (.pb.go etc.); stable within a group preserves
     * FTS order. Returns [] when nothing matches; a qualified lookup that finds no
     * exact match returns [] rather than a misleading fuzzy file hit (#173); a
     * bare name with no exact match falls back to the single top fuzzy result.
     */
    private findSymbolMatches;
    /**
     * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
     * results across all matching symbols (e.g., multiple classes with an `execute` method).
     */
    private findAllSymbols;
    /**
     * Truncate output if it exceeds the maximum length
     */
    private truncateOutput;
    private formatSearchResults;
    private formatNodeList;
    /**
     * Relationship label for a non-`calls` edge in callers/callees lists. A
     * function-as-value edge (#756) is the high-signal one: `callers(cb)`
     * showing "via callback registration" tells the agent this is where the
     * callback is WIRED, not where it's invoked.
     */
    private edgeLabel;
    private formatImpact;
    /**
     * Build a compact structural outline of a container symbol from its
     * indexed children (methods, fields, properties, …) — name, kind,
     * line number, and signature — so the agent gets the shape of a class
     * without the full source of every method. Returns '' when the container
     * has no indexed children, so the caller can fall back to full source.
     */
    private buildContainerOutline;
    private formatNodeDetails;
    private textResult;
    private errorResult;
}
export {};
//# sourceMappingURL=tools.d.ts.map