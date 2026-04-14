const { app } = require('@azure/functions');
const { QueryEngine } = require('@comunica/query-sparql-file');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────
const DEFAULT_LIMIT = 5000;
const DEFAULT_TIMEOUT_MS = 180000; // 3 minutes

// ─── Singleton Engine ────────────────────────────────────────────────────────
let engineInstance = null;
function getEngine() {
    if (!engineInstance) {
        engineInstance = new QueryEngine();
    }
    return engineInstance;
}

// ─── Query Execution ─────────────────────────────────────────────────────────
//
// SIMPLIFIED in v5.2.0: No more manual fetch/parse/RdfStore pipeline.
// @comunica/query-sparql-file fetches and parses TTL files internally,
// and the new group-file-sources optimizer (PR #1681) automatically combines
// multiple file sources into a single compositefile source, reducing union
// branches in the query plan.

const executeQuery = async (sparql, sources, limit, timeout) => {
    const engine = getEngine();
    const results = [];
    let hasMore = false;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
        const queryStart = Date.now();

        const bindingsStream = await engine.queryBindings(sparql, {
            sources,
            fetch: (url, init) => fetch(url, { ...init, signal: abortController.signal }),
        });

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
            queryTimeMs,
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
                queryTimeMs: result.queryTimeMs,
            };

            context.log(
                `FedQuery: returned=${result.data.length}, hasMore=${result.hasMore}, ` +
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
