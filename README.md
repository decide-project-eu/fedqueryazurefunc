# SPARQL Query Azure Function

This Azure Function executes federated SPARQL queries over one or more remote RDF/TTL sources. It fetches, parses, and queries the data in-memory for fast performance.

## Function Endpoints

- **POST `/api/FedQuery`**: Execute a SPARQL query with specified RDF sources.
- **GET `/api/FedQuery`**: Displays Azure Function documentation.

## How to Use

You can use **CURL**, **Postman**, or make a POST request programmatically to call this function.

### 1. Using curl

```bash
curl -X POST "<AZURE_FUNCTION_URL>/api/FedQuery" \
     -H "Content-Type: application/json" \
     -d '{
           "sparql": "SELECT * WHERE { ?s ?p ?o } LIMIT 100",
           "sources": [
               "https://solidserver.bovi-analytics.com/decide_lab1/Horizontal/HorizontalLab1.ttl",
               "https://solidserver.bovi-analytics.com/decide_lab2/Horizontal/HorizontalLab2.ttl"
           ]
         }'
```

### 2. Using Postman

1. Set the HTTP method to **POST**.
2. Enter the URL for the Azure Function endpoint: `<AZURE_FUNCTION_URL>/api/FedQuery`.
3. Set the headers: `Content-Type = application/json`.
4. In the body, select "raw" and enter the JSON query:

```json
{
    "sparql": "SELECT * WHERE { ?s ?p ?o } LIMIT 100",
    "sources": [
        "https://solidserver.bovi-analytics.com/decide_lab1/Horizontal/HorizontalLab1.ttl",
        "https://solidserver.bovi-analytics.com/decide_lab2/Horizontal/HorizontalLab2.ttl"
    ]
}
```

### 3. Programmatically

#### Node.js Example

```javascript
const query = {
    sparql: "SELECT * WHERE { ?s ?p ?o } LIMIT 100",
    sources: [
        "https://solidserver.bovi-analytics.com/decide_lab1/Horizontal/HorizontalLab1.ttl",
        "https://solidserver.bovi-analytics.com/decide_lab2/Horizontal/HorizontalLab2.ttl"
    ]
};

fetch('<AZURE_FUNCTION_URL>/api/FedQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query)
})
.then(response => response.json())
.then(data => console.log(data))
.catch(error => console.error('Error:', error));
```

#### Python Example

```python
import requests

url = "<AZURE_FUNCTION_URL>/api/FedQuery"
query = {
    "sparql": "SELECT * WHERE { ?s ?p ?o } LIMIT 100",
    "sources": [
        "https://solidserver.bovi-analytics.com/decide_lab1/Horizontal/HorizontalLab1.ttl",
        "https://solidserver.bovi-analytics.com/decide_lab2/Horizontal/HorizontalLab2.ttl"
    ]
}

response = requests.post(url, json=query, headers={'Content-Type': 'application/json'})
print(response.json())
```

## Request Body

The POST request requires a JSON body with the following structure:

```json
{
    "sparql": "SELECT * WHERE { ?s ?p ?o }",
    "sources": [
        "https://solidserver.bovi-analytics.com/decide_lab1/Horizontal/HorizontalLab1.ttl",
        "https://solidserver.bovi-analytics.com/decide_lab2/Horizontal/HorizontalLab2.ttl"
    ],
    "limit": 5000,
    "timeout": 180000
}
```

| Field       | Required | Default | Description                           |
| ----------- | -------- | ------- | ------------------------------------- |
| `sparql`  | Yes      | —      | SPARQL SELECT query string            |
| `sources` | Yes      | —      | Array of remote TTL file URLs         |
| `limit`   | No       | 5000    | Max rows to return (capped at 10,000) |
| `timeout` | No       | 180000  | Timeout in ms (capped at 300,000)     |

## Response Format

```json
{
    "data": [
        { "s": "http://example.org/subject", "p": "http://example.org/predicate", "o": "value" }
    ],
    "count": 100,
    "hasMore": true,
    "timedOut": false,
    "timeMs": 3316,
    "tripleCount": 806025,
    "fetchTimeMs": 3178,
    "queryTimeMs": 138
}
```

| Field            | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `data`         | Array of result objects (variable name → value)            |
| `count`        | Number of rows returned                                     |
| `hasMore`      | Whether more results exist beyond the limit                 |
| `timedOut`     | Whether the query was aborted due to timeout                |
| `timeMs`       | Total execution time in milliseconds                        |
| `tripleCount`  | Total RDF triples loaded into the in-memory store           |
| `fetchTimeMs`  | Time spent downloading and parsing TTL files                |
| `queryTimeMs`  | Time spent executing the SPARQL query                       |
| `sourceErrors` | (optional) Array of errors from sources that failed to load |

## Responses

- **200 OK**: Query results in JSON format.
- **400 Bad Request**: Invalid JSON or missing fields.
- **500 Internal Server Error**: An internal error occurred.

## Performance

Tested locally with 6 Solid-hosted TTL sources (~5 MB each, 806,025 total triples):

| Metric                 | Value                        |
| ---------------------- | ---------------------------- |
| Total time (6 sources) | **~3.3 seconds**       |
| Fetch + parse time     | ~3.2 seconds (network-bound) |
| SPARQL query time      | ~138 milliseconds            |

## Architecture & Performance

| Component      | Description                                         |
| -------------- | --------------------------------------------------- |
| Engine         | `@comunica/query-sparql-rdfjs` v5.1.3             |
| Strategy       | Parallel fetch → in-memory indexed store           |
| Parser         | N3.js                                               |
| Storage        | `rdf-stores` RdfStore with GSPO/GPOS/GOSP indexes |
| 6-source query | **3.3 seconds**                               |

## Notes

- Replace `<AZURE_FUNCTION_URL>` with the actual URL of your Azure Function.
- Ensure that the RDF sources you provide are accessible and properly formatted.
- The function processes SPARQL queries and returns results in JSON format.
- Failed sources are handled gracefully — partial results from healthy sources are still returned.
