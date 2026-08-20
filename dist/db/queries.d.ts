/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the knowledge graph.
 */
import { SqliteDatabase } from './sqlite-adapter';
import { Node, Edge, FileRecord, UnresolvedReference, NodeKind, EdgeKind, Language, GraphStats, SearchOptions, SearchResult } from '../types';
/**
 * Query builder for the knowledge graph database
 */
export declare class QueryBuilder {
    private db;
    private projectNameTokens;
    private nodeCache;
    private readonly maxCacheSize;
    private stmts;
    private segmentedNames;
    private static readonly MAX_SEGMENTED_NAMES;
    private batchStmts;
    private static readonly BATCH_SIZES;
    /**
     * Run `rows` through a multi-row `INSERT` built as `head + (tuple,)*n`,
     * decomposed greedily into the cached batch sizes. Preserves row order.
     */
    private runBatched;
    constructor(db: SqliteDatabase);
    /**
     * Swap the underlying connection in place. Used by pool workers'
     * connection recycling (plan §7a.6, writes-under-readers): a long-lived
     * read connection pins WAL checkpoint progress, and the deep WAL that
     * accumulates behind it taxes every main-thread B-tree page operation
     * (deletes measured 42.6s → 118.8s from 0 to 4 attached readers on
     * identical hardware). Workers therefore close and reopen their read-only
     * connection at the pool-idle boundary; everything above the connection —
     * this QueryBuilder, the resolver and its warm caches — survives, and only
     * connection-derived state (prepared statements) resets, re-preparing
     * lazily on next use.
     */
    rebind(db: SqliteDatabase): void;
    /** Set the normalized project-name tokens used to down-weight non-discriminative
     * query words in path scoring (#720). Called once when the project opens. */
    setProjectNameTokens(tokens: Set<string>): void;
    /** The normalized project-name tokens (#720); empty if none were derived. */
    getProjectNameTokens(): Set<string>;
    /**
     * Insert a new node
     */
    insertNode(node: Node): void;
    /** Which node kinds contribute their name to the segment vocabulary — the
     *  single gate shared by insertNode, updateNode, and the rebuild page query
     *  (getDistinctNodeNames), so the write paths can't drift apart. */
    private isSegmentableKind;
    /** Write `name`'s segments into name_segment_vocab (idempotent). */
    private insertNameSegments;
    /**
     * Insert multiple nodes in a transaction
     */
    insertNodes(nodes: Node[]): void;
    /**
     * Store one file's whole extraction bundle — nodes, edges, unresolved refs,
     * and the file record — in a SINGLE transaction. The bulk-index path calls
     * this once per file instead of opening one transaction per table (#1015
     * file-order commit discipline is unchanged: callers still invoke it in file
     * order, and row order within is input order).
     *
     * Edges MUST already be endpoint-filtered by the caller (the store path
     * filters to the file's own inserted node ids), so the per-file existence
     * SELECT that insertEdges() pays is skipped here.
     */
    storeFileBundle(bundle: {
        nodes: Node[];
        edges: Edge[];
        refs: UnresolvedReference[];
        file: FileRecord;
    }): void;
    /**
     * Collect (segment, name) rows for a name, honouring the same session-dedupe
     * semantics as insertNameSegments(). Shared by the bulk write paths.
     */
    private collectNameSegmentRows;
    /**
     * Update an existing node
     */
    updateNode(node: Node): void;
    /**
     * Delete a node by ID
     */
    deleteNode(id: string): void;
    /**
     * Delete all nodes for a file
     */
    deleteNodesByFile(filePath: string): void;
    /** Wipe the segment vocabulary. A full index calls this at its start; the
     *  node write path repopulates it as files (re-)index, so the end state is
     *  exactly the current names with no orphan rows. */
    clearNameSegmentVocab(): void;
    /** True when the vocab has no rows — an index built before the table existed.
     *  `sync` uses this to heal such databases (see rebuildNameSegmentVocabFrom). */
    isNameSegmentVocabEmpty(): boolean;
    /** One page of distinct segmentable node names, for batched vocab rebuilds
     *  (file basenames and import specifiers are excluded from the vocab — see
     *  insertNode). */
    getDistinctNodeNames(limit: number, offset: number): string[];
    /** Insert segments for a batch of names in one transaction (vocab heal path). */
    insertNameSegmentsBatch(names: string[]): void;
    /**
     * Names whose segments cover at least `minWords` distinct PROMPT WORDS —
     * the co-occurrence probe behind the prompt hook's medium tier: the words
     * "state" and "machine" both being segments of `OrderStateMachine` is strong
     * evidence the prompt names that symbol in prose. Ordered by coverage.
     *
     * Takes (segment variant → original word) pairs and folds variants back to
     * their word INSIDE the SQL: a name matching both `service` and `services`
     * counts ONE word, not two. Counting raw variants let plural-variant pairs
     * of a single word tie with genuine two-word matches and — because ORDER
     * BY/LIMIT run here, before any JS-side re-check — crowd a real match past
     * the LIMIT on vocab-heavy repos (#1146).
     */
    getSegmentCoOccurrence(variants: Array<{
        segment: string;
        word: string;
    }>, minWords: number, limit: number): Array<{
        name: string;
        matches: number;
    }>;
    /** How many distinct names each segment appears in — the rarity signal that
     *  separates a discriminative word ("checkout") from a ubiquitous one ("state"). */
    getSegmentNameCounts(segments: string[]): Map<string, number>;
    /** Names containing the given segment (rare-single-word tier). */
    getNamesForSegment(segment: string, limit: number): string[];
    /**
     * Get a node by ID
     */
    getNodeById(id: string): Node | null;
    /**
     * Batch lookup: fetch many nodes by ID in a single SQL round-trip.
     *
     * Replaces the N+1 pattern in graph traversal where every edge would
     * trigger its own `getNodeById` call. For a function with 50 callers
     * this collapses 50 point reads into one IN-list query (~10-50x
     * faster end-to-end).
     *
     * Returns a Map keyed by id so callers can preserve their own ordering
     * (typically the order edges were returned from the graph). Missing IDs
     * are simply absent from the map.
     *
     * Cache-aware: ids already in the LRU cache are served from memory and
     * the SQL query only touches the misses.
     */
    getNodesByIds(ids: readonly string[]): Map<string, Node>;
    private getExistingNodeIds;
    /**
     * Add a node to the cache, evicting oldest if needed
     */
    private cacheNode;
    /**
     * Clear the node cache
     */
    clearCache(): void;
    /**
     * Get all nodes in a file
     */
    getNodesByFile(filePath: string): Node[];
    /**
     * Find the file that holds the densest concentration of the project's
     * internal call graph — the "core" file. Used by context-builder to
     * boost ranking of symbols in that file's directory (so e.g. sinatra
     * queries surface `lib/sinatra/base.rb`'s `route!` instead of
     * `sinatra-contrib/lib/sinatra/multi_route.rb`'s `route` extension).
     *
     * Returns null if no file has a meaningful concentration (e.g. spread
     * evenly across many files, or empty index).
     *
     * "Internal" = source and target are in the same file. Cross-file
     * edges aren't useful here — they don't tell us which file is the
     * functional center.
     *
     * Excludes test/spec files from candidacy via path-pattern. The agent's
     * typical question is "how does X work", not "how is X tested", so
     * boosting a test file's directory would be a misfire.
     */
    getDominantFile(): {
        filePath: string;
        edgeCount: number;
        nextEdgeCount: number;
    } | null;
    /**
     * Find the file that holds the densest concentration of the project's
     * `route` nodes (framework-emitted: Express/Gin/Flask/Rails/Drupal/etc.).
     * Used by handleContext on small repos to inline the project's routing
     * config when the agent's query is about request flow — eliminating the
     * "Glob + Read routes.rb" pattern that beats codegraph on tiny realworld
     * template repos.
     *
     * Excludes test/generated files from candidacy. Returns null if there
     * are fewer than 3 non-test routes total, or if no file holds at least
     * 30% of them (diffuse routing → no single answer file).
     */
    getTopRouteFile(): {
        filePath: string;
        routeCount: number;
        totalRoutes: number;
    } | null;
    /**
     * Build a URL → handler manifest from the index. Each route node's
     * `references` edge points at the function/method that handles the
     * request. We join them in one pass; the agent gets the canonical
     * routing answer ("POST /users/login → AuthController#login") without
     * having to parse the framework's route DSL itself.
     *
     * Also returns the file with the most handler endpoints — used as the
     * "top handler file" to inline source for, so the agent has both the
     * mapping AND the handler implementations.
     */
    getRoutingManifest(limit?: number): {
        entries: Array<{
            url: string;
            handler: string;
            handlerFile: string;
            handlerLine: number;
            handlerKind: string;
        }>;
        topHandlerFile: string | null;
        topHandlerFileCount: number;
        totalRoutes: number;
    } | null;
    /**
     * Get all nodes of a specific kind
     */
    getNodesByKind(kind: NodeKind): Node[];
    /**
     * Stream every node of a kind one at a time (lazy) instead of materializing
     * them all like {@link getNodesByKind}. For unbounded kinds (`function`,
     * `method`) on a symbol-dense project the full array is gigabytes; the
     * dynamic-edge synthesizers only scan-and-filter, so they iterate to keep
     * memory O(1) in the node count rather than O(nodes) (#610).
     */
    iterateNodesByKind(kind: NodeKind): IterableIterator<Node>;
    /**
     * Get all nodes in the database
     */
    getAllNodes(): Node[];
    /**
     * Stream nodes of one language whose `decorators` JSON array contains
     * `decorator`. The LIKE on the JSON text is a cheap index-free pre-filter
     * (a decorator name can appear as a substring of another), so callers must
     * still exact-check `node.decorators.includes(decorator)`. Exists so the
     * kotlin expect/actual synthesizer never materializes the whole node table
     * the way `getAllNodes().filter(...)` did — that array alone OOM'd Node's
     * default heap on a 2M-node graph (#1212).
     */
    iterateNodesByLanguageWithDecorator(language: Language, decorator: string): IterableIterator<Node>;
    /**
     * Distinct languages present in the files table. One indexed aggregate —
     * lets the dynamic-edge synthesizers skip passes for languages the project
     * doesn't contain at all (a Kotlin pass has no work on a pure-C repo), so
     * their cost is zero rather than a full-graph scan that finds nothing (#1212).
     */
    getDistinctFileLanguages(): Set<string>;
    /**
     * Get nodes by exact name match (uses idx_nodes_name index).
     *
     * This is resolution's candidate list, and the ORDER BY is load-bearing for
     * index correctness, not cosmetic (CG-33). When a reference names a symbol
     * that several files define and nothing disambiguates them, resolution binds
     * to the first candidate — so without an ORDER BY the winner was decided by
     * rowid, i.e. by the order files happened to be WRITTEN. A full index writes
     * them in scan order; an incremental sync appends each file as it changes, so
     * the same tree resolved to different edges depending on how the index was
     * built, and a long-lived synced index drifted away from a rebuild of itself
     * (measured at 4.3% of distinct edges, mostly `calls`).
     *
     * `(file_path, start_line)` is a property of the CODE, so both paths now pick
     * the same candidate. The sort is paid once per distinct name per resolution
     * run — ReferenceResolver memoizes this in its nameCache — and the population
     * is capped by AMBIGUOUS_NAME_CEILING (#999).
     */
    getNodesByName(name: string): Node[];
    /**
     * Nodes whose name starts with `prefix`, by index range scan (a LIKE would
     * skip idx_nodes_name under SQLite's default case-insensitive LIKE).
     */
    getNodesByNamePrefix(prefix: string, limit?: number): Node[];
    /**
     * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
     */
    getNodesByQualifiedNameExact(qualifiedName: string): Node[];
    /**
     * Get nodes by lowercase name match (uses idx_nodes_lower_name expression index)
     */
    getNodesByLowerName(lowerName: string): Node[];
    /**
     * Search nodes by name using FTS with fallback to LIKE for better matching
     *
     * Search strategy:
     * 1. Try FTS5 prefix match (query*) for word-start matching
     * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
     * 3. Score results based on match quality
     */
    searchNodes(query: string, options?: SearchOptions): SearchResult[];
    /**
     * Match-everything path used when the user supplied only field
     * filters (`kind:function lang:typescript`) with no text. Returns
     * candidates ordered by name; the caller's filter pass narrows to
     * what was asked for.
     */
    private searchAllByFilters;
    /**
     * Fuzzy fallback: when zero FTS/LIKE hits, try an edit-distance
     * sweep over the distinct symbol-name set. Caps `maxDist` at 2 so
     * `getUssr` finds `getUser` but `process` doesn't match `prosody`.
     * Bounded edit distance keeps each comparison cheap; the per-query
     * scan is O(distinct-name-count) which is far smaller than total
     * node count on any real codebase.
     */
    private searchNodesFuzzy;
    /**
     * FTS5 search with prefix matching
     */
    private searchNodesFTS;
    /**
     * LIKE-based substring search for cases where FTS doesn't match
     * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
     */
    private searchNodesLike;
    /**
     * Find nodes by exact name match
     *
     * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
     * Returns high-confidence matches for known symbol names extracted from query.
     *
     * @param names - Array of symbol names to look up
     * @param options - Search options (kinds, languages, limit)
     * @returns SearchResult array with exact matches scored at 1.0
     */
    findNodesByExactName(names: string[], options?: SearchOptions): SearchResult[];
    /**
     * Find nodes whose name contains a substring (LIKE-based).
     * Useful for CamelCase-part matching where FTS fails because
     * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
     *
     * Results are ordered by name length (shorter = more likely to be the core type).
     */
    findNodesByNameSubstring(substring: string, options?: SearchOptions & {
        excludePrefix?: boolean;
    }): SearchResult[];
    /**
     * Insert a new edge
     */
    insertEdge(edge: Edge): void;
    /**
     * Insert multiple edges in a transaction
     */
    insertEdges(edges: Edge[]): void;
    /**
     * Delete all edges from a source node
     */
    deleteEdgesBySource(sourceId: string): void;
    /**
     * Get outgoing edges from a node
     */
    getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[];
    /**
     * Get incoming edges to a node
     */
    getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[];
    /**
     * Find all edges where both source and target are in the given node set.
     * Useful for recovering inter-node connectivity after BFS.
     */
    findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[];
    /**
     * Distinct file paths that DEPEND ON `filePath`: every file containing a
     * symbol with a cross-file edge (any kind except `contains`) into a symbol
     * of this file. This is the file-level projection of the symbol dependency
     * graph and the basis for blast-radius / `affected` test selection.
     *
     * It deliberately does NOT restrict to `imports` edges. In this graph an
     * `imports` edge connects a file to its own local import declarations
     * (it is always same-file), so an imports-only lookup returns zero
     * cross-file dependents for every file. The real cross-file dependency
     * signal is the resolved call/reference graph — calls, references,
     * instantiates, extends, implements, overrides, type_of, returns,
     * decorates — exactly what {@link GraphTraverser.getImpactRadius} traverses.
     * `contains` is excluded: a parent containing a symbol does not *depend* on
     * it. One indexed query (idx_nodes_file_path + idx_edges_target_kind).
     */
    getDependentFilePaths(filePath: string): string[];
    /**
     * Distinct file paths that `filePath` DEPENDS ON — the inverse of
     * {@link getDependentFilePaths}: every file containing a symbol that a
     * symbol of this file has a cross-file edge into. Same edge-kind rules
     * (all kinds except `contains`); same reason imports-only is insufficient.
     */
    getDependencyFilePaths(filePath: string): string[];
    /**
     * Cross-file edges whose TARGET is a node in `filePath` and whose SOURCE is a
     * node in a *different* file, paired with the target node's (name, kind) so a
     * caller can re-resolve the edge to the re-indexed target's new ID (node IDs
     * are `sha256(filePath:kind:name:line)`, so any line shift in the callee file
     * changes target IDs and a naive re-insert by old ID silently drops them).
     * Used by `storeExtractionResult` to preserve incoming edges across a file
     * re-index (issue #899). Same edge-kind rules as
     * {@link getDependentFilePaths}: all kinds except `contains`.
     */
    getCrossFileIncomingEdgesWithTarget(filePath: string): Array<Edge & {
        targetName: string;
        targetKind: NodeKind;
        sourceFilePath: string;
        sourceLanguage: Language;
    }>;
    /**
     * Insert or update a file record
     */
    upsertFile(file: FileRecord): void;
    /**
     * Which of `filePaths` the index flagged as tool-generated (schema v9+).
     *
     * Bounded-lookup by design: every consumer already holds a short candidate
     * list (a ranked file group, an FTS result page, a LIMIT-20 aggregate), so
     * this stays a partial-index probe over a handful of paths — no whole-repo
     * set to materialize, and no cache to invalidate, which means a ranking call
     * can never serve a verdict the last sync already replaced.
     *
     * Returns ONLY the content/index signal; callers union it with
     * {@link isGeneratedFile} so pre-v9 databases (column present, all zeros
     * until a re-index) keep the path-only behavior rather than regressing.
     */
    getGeneratedPathsAmong(filePaths: Iterable<string>): Set<string>;
    /**
     * A reusable `(path) => boolean` over a bounded candidate list, unioning the
     * indexed flag with the path convention. This is the shape every ranking
     * comparator wants: one query up front, then O(1) per comparison.
     */
    generatedPredicateFor(filePaths: Iterable<string>): (filePath: string) => boolean;
    /**
     * Which of `filePaths` are AMBIENT DECLARATION files — they declare nothing
     * but types, and nothing in the index depends on them (CG-28). A hand-written
     * ambient `.d.ts` of global shims, a vendored typings file, module
     * augmentation: reachable only by name, structurally attached to nothing.
     *
     * Structural, not extension-based, so a hand-written `types.ts` and a `.d.ts`
     * are judged by the same rule and a `.d.ts` that does declare a class or a
     * const is (correctly) not caught. Four conditions, all required:
     *
     *   1. it declares at least one symbol — an empty or unparsed file is not a
     *      declaration file, it is a file we know nothing about;
     *   2. EVERY declared symbol is a type-level kind (interface / type alias /
     *      enum / namespace). The narrowness is deliberate and measured: a rule
     *      of "no callables" alone flags 1–18% of a repo, including Kotlin sealed
     *      classes, Rust `mod.rs` re-exports and django's locale constant tables —
     *      real source that must not be demoted. This rule flags 0–4%;
     *   3. no symbol in it originates a `calls`/`instantiates` edge — the direct
     *      evidence that nothing here has a body;
     *   4. NOTHING ELSE IN THE INDEX points at it. This is the condition that
     *      separates an ambient shim from a working type module, and it is why
     *      the flag is narrow enough to be safe: `displacement-ts`'s pipeline
     *      `types.ts` passes 1–3 identically but carries 13 inbound imports and
     *      21 references, so the files that answer a query about the pipeline are
     *      typed BY it — it is part of that answer's structure. An ambient
     *      `declare global` shim has zero. Deliberately index-wide rather than
     *      restricted to the candidate list: the file that imports it is usually
     *      not itself a candidate.
     *
     * Bounded-lookup like {@link getGeneratedPathsAmong}: callers hold a ranked
     * candidate list, so this is a partial-index probe over a handful of paths.
     */
    getAmbientDeclarationPathsAmong(filePaths: Iterable<string>): Set<string>;
    /**
     * A reusable `(path) => boolean` ambient-declaration test over a bounded
     * candidate list — the shape a ranking comparator wants: one query up front,
     * O(1) per comparison.
     */
    ambientDeclarationPredicateFor(filePaths: Iterable<string>): (filePath: string) => boolean;
    /** How many indexed files carry the generated flag. Surfaced by `status`. */
    countGeneratedFiles(): number;
    /**
     * Delete a file record and its nodes
     */
    deleteFile(filePath: string): void;
    /**
     * Get a file record by path
     */
    getFileByPath(filePath: string): FileRecord | null;
    /**
     * Get all tracked files
     */
    getAllFiles(): FileRecord[];
    /**
     * Most recent index timestamp (ms since epoch) across all tracked files, or
     * null when nothing is indexed yet. One indexed aggregate, no per-row scan. (#329)
     */
    getLastIndexedAt(): number | null;
    /**
     * Get files that need re-indexing (hash changed)
     */
    getStaleFiles(currentHashes: Map<string, string>): FileRecord[];
    /**
     * Insert an unresolved reference
     */
    insertUnresolvedRef(ref: UnresolvedReference): void;
    /**
     * Insert multiple unresolved references in a transaction
     */
    insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void;
    /**
     * Delete unresolved references from a node
     */
    deleteUnresolvedByNode(nodeId: string): void;
    /**
     * Get unresolved references by name (for resolution)
     */
    getUnresolvedByName(name: string): UnresolvedReference[];
    /**
     * Get all unresolved references
     */
    getUnresolvedReferences(): UnresolvedReference[];
    /**
     * Get the count of PENDING (never-attempted) references without loading
     * them into memory. Rows marked status='failed' — attempted by a completed
     * pass, no match — are excluded: they are not outstanding work, only retry
     * candidates for the #1240 sweep, so they must not trip the #1187 orphan
     * sweep or the `status` pending-refs warning.
     */
    getUnresolvedReferencesCount(): number;
    /**
     * Get a batch of PENDING unresolved references using LIMIT/OFFSET
     * pagination. Used to process references in bounded memory chunks; failed
     * rows are excluded so the batched drain loop terminates once every row
     * has been attempted.
     */
    getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[];
    /**
     * Keyset variant of {@link getUnresolvedReferencesBatch} for the batched
     * resolution loop: seek past the last-seen row id instead of OFFSET-walking.
     * OFFSET reads re-scan the accumulated failed-row prefix on every batch —
     * O(failed rows) per read, measured at 54.6s of the kernel-scale batch loop
     * (§7a.2) — while the seek is O(batch) forever. `id` is the rowid alias, so
     * the enumeration order is identical to the OFFSET reader's.
     */
    getUnresolvedReferencesBatchAfter(afterRowId: number, limit: number): UnresolvedReference[];
    /**
     * Get all tracked file paths (lightweight — no full FileRecord objects)
     */
    getAllFilePaths(): string[];
    /**
     * Get all distinct node names (lightweight — just name strings for pre-filtering)
     */
    getAllNodeNames(): string[];
    /**
     * Stream the distinct node names one row at a time — the incremental
     * counterpart to {@link getAllNodeNames} for callers that need to yield
     * to the event loop mid-scan (resolver cache warm-up on multi-million-node
     * indexes). Fresh statement per call: the iterator holds an open cursor.
     */
    iterateNodeNames(): IterableIterator<string>;
    /**
     * Get unresolved references scoped to specific file paths.
     * Uses the idx_unresolved_file_path index for efficient lookup.
     */
    getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[];
    /**
     * Delete all unresolved references (after resolution)
     */
    clearUnresolvedReferences(): void;
    /**
     * Delete resolved references by their IDs
     */
    deleteResolvedReferences(fromNodeIds: string[]): void;
    /**
     * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
     * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
     */
    deleteSpecificResolvedReferences(refs: Array<{
        fromNodeId: string;
        referenceName: string;
        referenceKind: string;
    }>): number;
    /**
     * Delete unresolved-ref rows by row id — the precise cleanup for refs a
     * resolution pass actually processed. The key-tuple variant above also
     * deletes SIBLING rows (same caller calling the same callee at other lines)
     * that a later batch hasn't attempted yet, so when a batch boundary split a
     * caller's same-named call sites, the later sites' edges were silently never
     * created (#1269).
     */
    deleteReferencesByRowIds(rowIds: number[]): number;
    /**
     * Mark refs a completed resolution pass could not resolve as status='failed'
     * instead of deleting them (#1240). Failed rows are invisible to the pending
     * count/batch readers (so drain loops and the #1187 orphan sweep still
     * terminate) but stay queryable by name_tail so a later sync can retry them
     * when a changed file introduces a symbol that could satisfy them. name_tail
     * is (re)written here so rows inserted before the v8 migration get their
     * tail the first time they're attempted.
     */
    markReferencesFailed(refs: Array<{
        fromNodeId: string;
        referenceName: string;
        referenceKind: string;
    }>): number;
    /**
     * Park refs as status='failed' by row id — the precise counterpart of
     * markReferencesFailed, for the same reason as deleteReferencesByRowIds:
     * the key-tuple variant also flips same-key sibling rows in later batches
     * to 'failed' before they were ever attempted (#1269). Resolution outcome
     * can differ per call site (receiver-type inference reads the ref's line),
     * so a sibling must not inherit this row's failure.
     */
    markReferencesFailedByRowIds(refs: Array<{
        rowId: number;
        referenceName: string;
    }>): number;
    /**
     * Failed refs whose name tail matches one of the given symbol names — the
     * candidates a sync should retry after files carrying those names changed
     * (#1240). Names matching more than `perNameCeiling` failed refs are
     * skipped entirely: at that population a name is external/builtin noise
     * (`get`, `map`, …) that one new definition won't resolve — the same
     * rationale as resolution's AMBIGUOUS_NAME_CEILING (#999) — and retrying an
     * arbitrary subset would be both wasted work and incoherent coverage.
     */
    getRetryableFailedReferences(names: string[], perNameCeiling?: number): UnresolvedReference[];
    /**
     * Resolution edges whose TARGET symbol is named one of `names` — the edges a
     * sync must re-resolve after `names` gained or lost a definition (CG-33).
     *
     * Resolution binds a reference to a node whose name matches the reference's
     * tail, and it picks among ALL same-named definitions project-wide. So adding
     * or removing one definition of `pct` changes the answer for every `pct(...)`
     * reference in the repo — including references in files this sync never
     * touches, whose edges nothing else revisits. Those edges' current target is,
     * by that same rule, a node named `pct`, which is why the target's name is a
     * sufficient (and index-backed, via idx_nodes_name) way to find them without
     * a schema change or a scan of edge metadata.
     *
     * Returns the source file/language alongside each edge so the caller can
     * resurrect it as its original reference. Excludes `provenance='heuristic'`
     * (synthesized dispatch edges are not resolution output and carry no refName
     * stamp to resurrect from — deleting one would be a permanent loss).
     *
     * Names matching more than `perNameCeiling` edges are skipped entirely, same
     * rationale and same default as {@link getRetryableFailedReferences}: at that
     * population the name is generic (`get`, `clear`, …), one definition changing
     * won't flip most of them, and rebinding an arbitrary subset is both wasted
     * work and incoherent coverage.
     */
    getResolutionEdgesByTargetName(names: string[], perNameCeiling?: number): Array<Edge & {
        edgeId: number;
        sourceFilePath: string;
        sourceLanguage: Language;
    }>;
    /** Delete edges by primary key — the rebind pass's half of a re-resolution. */
    deleteEdgesByIds(edgeIds: number[]): number;
    /**
     * Distinct node names present in the given files — the symbol names a sync
     * pass uses to look up retryable failed refs after those files changed.
     */
    getNodeNamesByFiles(filePaths: string[]): string[];
    /**
     * Distinct `file\0name` pairs defined by the given files — the shape sync's
     * definition delta needs (CG-33).
     *
     * Deliberately NOT `getNodeNamesByFiles`: a bare name set is taken over the
     * WHOLE changed batch, so a name that moves between two files in one commit
     * (or exists in one changed file and is newly added to another) appears on
     * both sides and cancels out of the symmetric difference — even though a
     * definition genuinely appeared or vanished and every reference to that name
     * repo-wide may now bind elsewhere. Keying by file makes each definition its
     * own fact, so the move is seen as one removal plus one addition.
     */
    getNodeNamePairsByFiles(filePaths: string[]): Set<string>;
    /**
     * Lightweight (nodes, edges) count snapshot. Used around an index/sync
     * run to compute true additions across extraction + resolution +
     * synthesis — the per-phase counter in the orchestrator only sees
     * extraction's contribution, which is why the CLI summary under-reported
     * the edge count (resolution + synthesizer edges were invisible).
     */
    getNodeAndEdgeCount(): {
        nodes: number;
        edges: number;
    };
    /**
     * Get graph statistics
     */
    getStats(): GraphStats;
    /**
     * Get a metadata value by key
     */
    getMetadata(key: string): string | null;
    /**
     * Set a metadata key-value pair (upsert)
     */
    setMetadata(key: string, value: string): void;
    /**
     * Get all metadata as a key-value record
     */
    getAllMetadata(): Record<string, string>;
    /**
     * Clear all data from the database
     */
    clear(): void;
}
//# sourceMappingURL=queries.d.ts.map