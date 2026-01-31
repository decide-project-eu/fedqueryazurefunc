const { app } = require('@azure/functions');
const { QueryEngine } = require('@comunica/query-sparql');
const fs = require('fs');
const path = require('path');

// Simple configuration
const DEFAULT_LIMIT = 5000;
const DEFAULT_TIMEOUT_MS = 180000; // 3 minutes

// Execute SPARQL query - simple streaming approach
const executeQuery = async (sparql, sources, limit, timeout) => {
    const engine = new QueryEngine();
    const results = [];
    let hasMore = false;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
        const bindingsStream = await engine.queryBindings(sparql, {
            sources,
            httpAbortSignal: abortController.signal,
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

        return { data: results, hasMore, timedOut: false };

    } catch (error) {
        if (error.name === 'AbortError' || abortController.signal.aborted) {
            return { data: results, hasMore: true, timedOut: true };
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
        try { await engine.invalidateHttpCache(); } catch (e) {}
    }
};

// Main endpoint
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
            };

            context.log(`FedQuery: returned=${result.data.length}, hasMore=${result.hasMore}, time=${response.timeMs}ms`);

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
