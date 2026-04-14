# SPARQL Query Azure Function

This Azure Function executes federated SPARQL queries over one or more remote RDF/TTL sources using Comunica's file query engine with automatic multi-source optimization.

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
| `timeout` | No       | 300000  | Timeout in ms (capped at 300,000)     |

## Response Format

```json
{
    "data": [
        { "s": "http://example.org/subject", "p": "http://example.org/predicate", "o": "value" }
    ],
    "count": 100,
    "hasMore": false,
    "timedOut": false,
    "timeMs": 22500,
    "queryTimeMs": 22500
}
```

| Field          | Description                                          |
| -------------- | ---------------------------------------------------- |
| `data`       | Array of result objects (variable name → value)     |
| `count`      | Number of rows returned                              |
| `hasMore`    | Whether more results exist beyond the limit          |
| `timedOut`   | Whether the query was aborted due to timeout         |
| `timeMs`     | Total execution time in milliseconds                 |
| `queryTimeMs`| Time spent fetching sources and executing the query  |

## Responses

- **200 OK**: Query results in JSON format.
- **400 Bad Request**: Invalid JSON or missing fields.
- **500 Internal Server Error**: An internal error occurred.

## Performance

Benchmarked against Solid-hosted TTL sources (5–12 sources, up to 12 pods):

| Experiment                          | Mean time |
| ----------------------------------- | --------- |
| Q1 simple — 5 cattle pods           | ~22 s     |
| Q2 UNION — 12 vertical species pods | ~23 s     |
| Q2 UNION — 6 horizontal pods        | ~23 s     |

## Architecture

| Component  | Description                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| Engine     | `@comunica/query-sparql-file` v5.2.0                                      |
| Strategy   | Comunica fetches and parses TTL sources internally; the `group-file-sources` optimizer automatically merges multiple file sources into a single in-memory store before querying |
| Singleton  | Engine instance is reused across requests to avoid startup overhead         |
| Timeout    | AbortController with custom fetch ensures HTTP fetches are cancelled on timeout |

## Credits

This function is built on [Comunica](https://github.com/comunica/comunica), a highly modular and flexible meta query engine for the Web. Performance improvements in v5.2.0 are made possible by [PR #1681](https://github.com/comunica/comunica/pull/1681).

```
Taelman, R., Van Herwegen, J., Vander Sande, M., & Verborgh, R. (2018).
Comunica: a Modular SPARQL Query Engine for the Web.
In Proceedings of the 17th International Semantic Web Conference (ISWC).
https://doi.org/10.1007/978-3-030-00671-6_15
```

## Notes

- Replace `<AZURE_FUNCTION_URL>` with the actual URL of your Azure Function.
- Ensure that the RDF sources you provide are accessible and properly formatted.
- The function processes SPARQL queries and returns results in JSON format.
