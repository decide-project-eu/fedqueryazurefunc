const { app } = require('@azure/functions');
const { QueryEngine } = require('@comunica/query-sparql');
const fs = require('fs');
const path = require('path');

// Configuration constants
const CONFIG = {
    DEFAULT_PAGE_SIZE: 500,
    MAX_PAGE_SIZE: 2000,
    DEFAULT_TIMEOUT_MS: 90000,  // 90 seconds - sufficient for 500 records/page
    MAX_TIMEOUT_MS: 150000,     // 150 seconds max - for larger pages
    DEFAULT_CURSOR_FIELD: 'Sample',
};

// Create a new engine instance per request for isolation
const createEngine = () => new QueryEngine();

/**
 * Inject cursor filter into SPARQL query for efficient pagination
 *
 * This modifies the query to:
 * 1. Add ORDER BY for consistent ordering
 * 2. Add FILTER to skip results before the cursor
 *
 * @param {string} sparql - Original SPARQL query
 * @param {string} cursor - Last seen value (URI) to continue from
 * @param {string} cursorField - Variable name to use for cursor (e.g., 'Sample')
 * @returns {string} Modified SPARQL query
 */
const injectCursorFilter = (sparql, cursor, cursorField) => {
    if (!cursor) return sparql;

    // Escape special characters in cursor value for SPARQL
    const escapedCursor = cursor.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    // Build the cursor filter
    const cursorFilter = `FILTER(STR(?${cursorField}) > "${escapedCursor}")`;

    // Find the WHERE clause and inject the filter
    // Handle both single WHERE {} and nested patterns
    const whereMatch = sparql.match(/WHERE\s*\{/i);
    if (!whereMatch) {
        throw new Error('Cannot inject cursor: WHERE clause not found in query');
    }

    const whereIndex = whereMatch.index + whereMatch[0].length;
    const modifiedSparql =
        sparql.slice(0, whereIndex) +
        `\n  ${cursorFilter}\n` +
        sparql.slice(whereIndex);

    return modifiedSparql;
};

/**
 * Add ORDER BY clause if not present (required for consistent cursor pagination)
 *
 * @param {string} sparql - SPARQL query
 * @param {string} cursorField - Field to order by
 * @returns {string} Query with ORDER BY
 */
const ensureOrderBy = (sparql, cursorField) => {
    // Check if ORDER BY already exists
    if (/ORDER\s+BY/i.test(sparql)) {
        return sparql;
    }

    // Remove existing LIMIT/OFFSET (we handle these ourselves)
    let cleanedSparql = sparql
        .replace(/\bLIMIT\s+\d+/gi, '')
        .replace(/\bOFFSET\s+\d+/gi, '')
        .trim();

    // Add ORDER BY before any trailing }
    // Find the last closing brace of the WHERE clause
    const lastBraceIndex = cleanedSparql.lastIndexOf('}');
    if (lastBraceIndex === -1) {
        return cleanedSparql + `\nORDER BY ?${cursorField}`;
    }

    return cleanedSparql + `\nORDER BY ?${cursorField}`;
};

/**
 * Execute SPARQL query with cursor-based pagination
 *
 * Cursor pagination is more efficient than offset because:
 * - Offset: Must scan and skip N results (O(n) for page n)
 * - Cursor: Filters directly to starting point (O(1) for any page)
 */
const executeQueryWithCursor = async (sparql, sources, options = {}) => {
    const {
        cursor = null,
        cursorField = CONFIG.DEFAULT_CURSOR_FIELD,
        limit = CONFIG.DEFAULT_PAGE_SIZE,
        timeout = CONFIG.DEFAULT_TIMEOUT_MS,
    } = options;

    const engine = createEngine();
    const results = [];
    let hasMore = false;
    let lastCursorValue = null;

    // Prepare the query with cursor support
    let preparedQuery = ensureOrderBy(sparql, cursorField);
    if (cursor) {
        preparedQuery = injectCursorFilter(preparedQuery, cursor, cursorField);
    }

    // Create abort controller for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
        abortController.abort();
    }, timeout);

    try {
        const bindingsStream = await engine.queryBindings(preparedQuery, {
            sources,
            httpAbortSignal: abortController.signal,
        });

        // Process results
        for await (const binding of bindingsStream) {
            if (abortController.signal.aborted) {
                hasMore = true;
                break;
            }

            // We fetch limit + 1 to check if there are more results
            if (results.length >= limit) {
                hasMore = true;
                break;
            }

            // Convert binding to simple object
            const result = {};
            binding.forEach((value, key) => {
                result[key.value] = value.value;
            });

            // Track the cursor field value for next page
            if (result[cursorField]) {
                lastCursorValue = result[cursorField];
            }

            results.push(result);
        }

        return {
            data: results,
            pagination: {
                type: 'cursor',
                cursorField,
                limit,
                returned: results.length,
                hasMore,
                nextCursor: hasMore ? lastCursorValue : null,
            },
            meta: {
                queryTimeMs: Date.now(),
                sourcesQueried: sources.length,
            },
        };
    } catch (error) {
        if (error.name === 'AbortError' || abortController.signal.aborted) {
            return {
                data: results,
                pagination: {
                    type: 'cursor',
                    cursorField,
                    limit,
                    returned: results.length,
                    hasMore: true,
                    nextCursor: lastCursorValue,
                },
                meta: {
                    timedOut: true,
                    message: 'Query timed out. Partial results returned. Use nextCursor to continue.',
                },
            };
        }
        throw new Error(`Error executing SPARQL query: ${error.message}`);
    } finally {
        clearTimeout(timeoutId);
        await engine.invalidateHttpCache();
    }
};

/**
 * Execute SPARQL query with offset-based pagination (legacy)
 */
const executeQueryWithOffset = async (sparql, sources, options = {}) => {
    const {
        offset = 0,
        limit = CONFIG.DEFAULT_PAGE_SIZE,
        timeout = CONFIG.DEFAULT_TIMEOUT_MS,
    } = options;

    const engine = createEngine();
    const results = [];
    let skipped = 0;
    let hasMore = false;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
        abortController.abort();
    }, timeout);

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

            if (skipped < offset) {
                skipped++;
                continue;
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

        return {
            data: results,
            pagination: {
                type: 'offset',
                offset,
                limit,
                returned: results.length,
                hasMore,
                nextOffset: hasMore ? offset + limit : null,
            },
            meta: {
                queryTimeMs: Date.now(),
                sourcesQueried: sources.length,
            },
        };
    } catch (error) {
        if (error.name === 'AbortError' || abortController.signal.aborted) {
            return {
                data: results,
                pagination: {
                    type: 'offset',
                    offset,
                    limit,
                    returned: results.length,
                    hasMore: true,
                    nextOffset: offset + results.length,
                },
                meta: {
                    timedOut: true,
                    message: 'Query timed out. Partial results returned.',
                },
            };
        }
        throw new Error(`Error executing SPARQL query: ${error.message}`);
    } finally {
        clearTimeout(timeoutId);
        await engine.invalidateHttpCache();
    }
};

/**
 * Validate and sanitize request parameters
 */
const validateRequest = (body) => {
    const errors = [];

    if (!body.sparql || typeof body.sparql !== 'string') {
        errors.push('SPARQL query is required and must be a string');
    }

    if (!Array.isArray(body.sources) || body.sources.length === 0) {
        errors.push('At least one RDF source URL is required');
    }

    if (body.sources) {
        body.sources.forEach((source, i) => {
            if (typeof source !== 'string' || !source.startsWith('http')) {
                errors.push(`Source ${i} must be a valid HTTP(S) URL`);
            }
        });
    }

    // Determine pagination mode: cursor (preferred) or offset (legacy)
    const useCursor = body.cursor !== undefined || body.cursorField !== undefined;

    // Validate pagination parameters
    const limit = Math.min(
        parseInt(body.limit, 10) || CONFIG.DEFAULT_PAGE_SIZE,
        CONFIG.MAX_PAGE_SIZE
    );
    const timeout = Math.min(
        parseInt(body.timeout, 10) || CONFIG.DEFAULT_TIMEOUT_MS,
        CONFIG.MAX_TIMEOUT_MS
    );

    // Cursor-specific params
    const cursor = body.cursor || null;
    const cursorField = body.cursorField || CONFIG.DEFAULT_CURSOR_FIELD;

    // Offset-specific params (legacy)
    const offset = parseInt(body.offset, 10) || 0;

    return {
        isValid: errors.length === 0,
        errors,
        params: {
            sparql: body.sparql,
            sources: body.sources,
            limit: Math.max(1, limit),
            timeout: Math.max(1000, timeout),
            // Pagination mode
            paginationMode: useCursor ? 'cursor' : 'offset',
            // Cursor params
            cursor,
            cursorField,
            // Offset params
            offset: Math.max(0, offset),
        },
    };
};

// HTTP trigger for FedQuery
app.http('FedQuery', {
    methods: ['POST', 'GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const startTime = Date.now();

        try {
            const apiUrl = new URL(request.url).origin;

            if (request.method === 'GET') {
                const htmlFilePath = path.join(__dirname, '../doc/doc.html');
                let documentation = fs.readFileSync(htmlFilePath, 'utf8');
                documentation = documentation.replace(/<span id="api-url.*?"><\/span>/g, apiUrl);

                return {
                    status: 200,
                    body: documentation,
                    headers: { 'Content-Type': 'text/html' },
                };
            }

            // POST request handling
            let body;
            try {
                body = await request.json();
            } catch (error) {
                context.log('Invalid JSON in request body:', error);
                return {
                    status: 400,
                    body: JSON.stringify({
                        error: 'Invalid JSON in request body',
                        code: 'INVALID_JSON',
                    }),
                    headers: { 'Content-Type': 'application/json' },
                };
            }

            // Validate request
            const validation = validateRequest(body);
            if (!validation.isValid) {
                return {
                    status: 400,
                    body: JSON.stringify({
                        error: 'Validation failed',
                        code: 'VALIDATION_ERROR',
                        details: validation.errors,
                    }),
                    headers: { 'Content-Type': 'application/json' },
                };
            }

            const { sparql, sources, limit, timeout, paginationMode, cursor, cursorField, offset } = validation.params;

            context.log(`FedQuery: Processing request - mode=${paginationMode}, limit=${limit}, sources=${sources.length}`);

            // Execute query with appropriate pagination mode
            let result;
            if (paginationMode === 'cursor') {
                context.log(`FedQuery: Using cursor pagination - cursor=${cursor}, field=${cursorField}`);
                result = await executeQueryWithCursor(sparql, sources, {
                    cursor,
                    cursorField,
                    limit,
                    timeout,
                });
            } else {
                context.log(`FedQuery: Using offset pagination - offset=${offset}`);
                result = await executeQueryWithOffset(sparql, sources, {
                    offset,
                    limit,
                    timeout,
                });
            }

            // Add timing information
            result.meta.totalTimeMs = Date.now() - startTime;

            context.log(`FedQuery: Completed - returned=${result.data.length}, hasMore=${result.pagination.hasMore}, time=${result.meta.totalTimeMs}ms`);

            // Build response headers
            const headers = {
                'Content-Type': 'application/json',
                'X-Query-Time-Ms': result.meta.totalTimeMs.toString(),
                'X-Results-Returned': result.data.length.toString(),
                'X-Has-More': result.pagination.hasMore.toString(),
                'X-Pagination-Mode': result.pagination.type,
            };

            // Add cursor-specific headers
            if (result.pagination.type === 'cursor' && result.pagination.nextCursor) {
                headers['X-Next-Cursor'] = result.pagination.nextCursor;
            }

            return {
                status: 200,
                body: JSON.stringify(result),
                headers,
            };

        } catch (error) {
            const errorTime = Date.now() - startTime;
            context.log('Error processing request:', error);

            return {
                status: 500,
                body: JSON.stringify({
                    error: error.message,
                    code: 'INTERNAL_ERROR',
                    timeMs: errorTime,
                }),
                headers: { 'Content-Type': 'application/json' },
            };
        }
    },
});

// Legacy endpoint for backward compatibility (returns flat array)
app.http('FedQueryLegacy', {
    route: 'FedQueryLegacy',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { sparql, sources } = body;

            if (!sparql || !Array.isArray(sources) || sources.length === 0) {
                return {
                    status: 400,
                    body: JSON.stringify({ error: 'Invalid request' }),
                    headers: { 'Content-Type': 'application/json' },
                };
            }

            const result = await executeQueryWithOffset(sparql, sources, {
                offset: 0,
                limit: CONFIG.MAX_PAGE_SIZE,
                timeout: CONFIG.DEFAULT_TIMEOUT_MS,
            });

            // Return flat array for backward compatibility
            return {
                status: 200,
                body: JSON.stringify(result.data),
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
