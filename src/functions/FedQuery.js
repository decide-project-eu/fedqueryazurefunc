const { app } = require('@azure/functions');
const { QueryEngine } = require('@comunica/query-sparql-rdfjs');
const N3 = require('n3');
const { RdfStore } = require('rdf-stores');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────
const DEFAULT_LIMIT = 5000;
const DEFAULT_TIMEOUT_MS = 180000; // 3 minutes

// ─── Singleton Engine ────────────────────────────────────────────────────────
// The RDFJS engine is reused across invocations to avoid the ~1-2s startup cost
// of compiling Comunica's dependency injection graph on every request.
let engineInstance = null;
function getEngine() {
    if (!engineInstance) {
        engineInstance = new QueryEngine();
    }
    return engineInstance;
}

// ─── TTL Fetch & Parse ───────────────────────────────────────────────────────
//
// PERFORMANCE FIX: The previous version used @comunica/query-sparql which treats
// each remote URL as a federated HTTP source. It evaluates SPARQL triple patterns
// one at a time over the network stream — catastrophically slow for large TTL files
// (5MB+ each). A query over 6 sources would never complete.
//
// The fast approach (matches Python/rdflib performance):
//   1. Fetch all TTL files in parallel via native fetch()
//   2. Parse them with N3.js into an indexed in-memory RdfStore
//   3. Query the store using Comunica's query-sparql-rdfjs engine
//
// The RdfStore uses GSPO/GPOS/GOSP triple indexes for O(log n) pattern matching
// instead of O(n) full scans per triple pattern.

/**
 * Fetch a single TTL file and parse it into RDF quads.
 */
async function fetchAndParseTtl(url, signal) {
    const response = await fetch(url, {
        signal,
        headers: { Accept: 'text/turtle' },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const ttlText = await response.text();

    return new Promise((resolve, reject) => {
        const quads = [];
        const parser = new N3.Parser({ baseIRI: url });

        parser.parse(ttlText, (error, quad) => {
            if (error) {
                reject(new Error(`Parse error for ${url}: ${error.message}`));
                return;
            }
            if (quad) {
                quads.push(quad);
            } else {
                resolve(quads);
            }
        });
    });
}

/**
 * Fetch all TTL sources in parallel and load into an indexed RdfStore.
 * Uses Promise.allSettled so one failing source doesn't abort the whole query.
 */
async function loadSourcesToStore(urls, signal) {
    const store = RdfStore.createDefault();
    const errors = [];

    const results = await Promise.allSettled(
        urls.map(url => fetchAndParseTtl(url, signal)),
    );

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
            for (const quad of result.value) {
                store.addQuad(quad);
            }
        } else {
            errors.push(`${urls[i]}: ${result.reason?.message ?? 'Unknown error'}`);
        }
    }

    return { store, tripleCount: store.size, errors };
}

// ─── Query Execution ─────────────────────────────────────────────────────────

const executeQuery = async (sparql, sources, limit, timeout) => {
    const engine = getEngine();
    const results = [];
    let hasMore = false;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
        // Phase 1: Fetch & parse all TTL files into an indexed in-memory store
        const fetchStart = Date.now();
        const { store, tripleCount, errors } = await loadSourcesToStore(
            sources,
            abortController.signal,
        );
        const fetchTimeMs = Date.now() - fetchStart;

        if (tripleCount === 0) {
            throw new Error(
                `No triples loaded from any source. Errors: ${errors.join('; ')}`,
            );
        }

        // Phase 2: Query the in-memory store via Comunica RDFJS engine.
        const queryStart = Date.now();
        const bindingsStream = await engine.queryBindings(sparql, {
            sources: [store],
        });

        // STREAM FIX: Must use `for await` — NOT stream.on('data'/'end').
        //
        // Comunica's BindingsStream extends AsyncIterator (pull-based model),
        // not a standard Node.js Readable stream. Using .on('data')/.on('end')
        // deadlocks because AsyncIterator doesn't reliably emit 'end' after
        // destroy(). The `for await` protocol correctly handles the pull-based
        // iteration and cleanup.
        for await (const binding of bindingsStream) {
            if (abortController.signal.aborted) {
                hasMore = true;
                break;
            }

            if (results.length >= limit) {
                hasMore = true;
                break;
            }

            const result = {};
            binding.forEach((value, key) => {
                result[key.value] = value.value;
            });
            results.push(result);
        }

        const queryTimeMs = Date.now() - queryStart;

        return {
            data: results,
            hasMore,
            timedOut: false,
            tripleCount,
            fetchTimeMs,
            queryTimeMs,
            sourceErrors: errors.length > 0 ? errors : undefined,
        };

    } catch (error) {
        if (error.name === 'AbortError' || abortController.signal.aborted) {
            return { data: results, hasMore: true, timedOut: true };
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
};

// ─── Azure Function Handler ──────────────────────────────────────────────────

app.http('FedQuery', {
    methods: ['POST', 'GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const startTime = Date.now();

        try {
            // GET - documentation
            if (request.method === 'GET') {
                const htmlPath = path.join(__dirname, '../doc/doc.html');
                let doc = fs.readFileSync(htmlPath, 'utf8');
                doc = doc.replace(/<span id="api-url.*?"><\/span>/g, new URL(request.url).origin);
                return { status: 200, body: doc, headers: { 'Content-Type': 'text/html' } };
            }

            // POST - query
            const body = await request.json();

            if (!body.sparql || !Array.isArray(body.sources) || body.sources.length === 0) {
                return {
                    status: 400,
                    body: JSON.stringify({ error: 'sparql and sources required' }),
                    headers: { 'Content-Type': 'application/json' },
                };
            }

            const limit = Math.min(body.limit || DEFAULT_LIMIT, 10000);
            const timeout = Math.min(body.timeout || DEFAULT_TIMEOUT_MS, 300000);

            context.log(`FedQuery: limit=${limit}, timeout=${timeout}ms, sources=${body.sources.length}`);

            const result = await executeQuery(body.sparql, body.sources, limit, timeout);

            const response = {
                data: result.data,
                count: result.data.length,
                hasMore: result.hasMore,
                timedOut: result.timedOut,
                timeMs: Date.now() - startTime,
                tripleCount: result.tripleCount,
                fetchTimeMs: result.fetchTimeMs,
                queryTimeMs: result.queryTimeMs,
                sourceErrors: result.sourceErrors,
            };

            context.log(
                `FedQuery: returned=${result.data.length}, hasMore=${result.hasMore}, ` +
                `triples=${result.tripleCount}, fetch=${result.fetchTimeMs}ms, ` +
                `query=${result.queryTimeMs}ms, total=${response.timeMs}ms`
            );

            return {
                status: 200,
                body: JSON.stringify(response),
                headers: { 'Content-Type': 'application/json' },
            };

        } catch (error) {
            context.log('Error:', error);
            return {
                status: 500,
                body: JSON.stringify({ error: error.message }),
                headers: { 'Content-Type': 'application/json' },
            };
        }
    },
});
