const { app } = require('@azure/functions');
const { QueryEngine } = require('@comunica/query-sparql');
const fs = require('fs');
const path = require('path');
const engine = new QueryEngine();

const executeQuery = async (sparql, sources) => {
    try {
        // Execute the query using Comunica
        const bindingsStream = await engine.queryBindings(sparql, { sources });

        // Convert the bindings stream to an array of results
        const results = await bindingsStream.toArray();

        // Map the bindings to a simpler format
        return results.map(binding => {
            const result = {};
            binding.forEach((value, key) => {
                result[key.value] = value.value;
            });
            return result;
        });
    } catch (error) {
        throw new Error(`Error executing SPARQL query: ${error.message}`);
    }
};

// HTTP trigger for FedQuery
app.http('FedQuery', {
    methods: ['POST', 'GET'], // Allow both POST and GET methods for this function
    authLevel: 'anonymous', // No authentication required
    handler: async (request, context) => {
        try {
            const apiUrl = new URL(request.url).origin; // Get the base URL dynamically
            if (request.method === 'GET') {
                // Provide API documentation for the GET request
                // Read the HTML file
                const htmlFilePath = path.join(__dirname, '../doc/doc.html');
                let documentation = fs.readFileSync(htmlFilePath, 'utf8');

                // Replace placeholders with the dynamic API URL
                documentation = documentation.replace(/<span id="api-url.*?"><\/span>/g, apiUrl);
                return {
                    status: 200,
                    body: documentation,
                    headers: {
                        'Content-Type': 'text/html',
                    },
                };
            } else if (request.method === 'POST') {
                // Process the POST request as per the existing logic
                let body;
                try {
                    body = await request.json();
                } catch (error) {
                    context.log('Invalid JSON in request body:', error);
                    return { status: 400, body: { error: "Invalid JSON in request body" } };
                }

                const { sparql, sources } = body;

                if (!sparql) {
                    context.log('SPARQL query is missing in the request body');
                    return { status: 400, body: { error: "SPARQL query is required in the request body" } };
                }

                if (!Array.isArray(sources) || sources.length === 0) {
                    context.log('Sources are missing or invalid in the request body');
                    return { status: 400, body: { error: "At least one RDF source (TTL file URL) is required" } };
                }

                const queryResults = await executeQuery(sparql, sources);

                return {
                    status: 200,
                    body: JSON.stringify(queryResults),
                    headers: {
                        'Content-Type': 'application/json',
                    },
                };
            }
        } catch (error) {
            context.log('Error processing request:', error);
            return { status: 500, body: { error: error.message } };
        }
    },
});
