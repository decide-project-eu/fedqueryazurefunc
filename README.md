# SPARQL Query Azure Function

This Azure Function allows you to execute a SPARQL query over one or more RDF sources.

## Function Endpoints

- **POST `/api/FedQuery`**: Execute a SPARQL query with specified RDF sources.

## How to Use

You can use **CURL**, **Postman**, or make a POST request programmatically to call this function.

### 1. Using curl

```bash
curl -X POST "<AZURE_FUNCTION_URL>/api/FedQuery" \
     -H "Content-Type: application/json" \
     -d '{
           "sparql": "SELECT * WHERE { ?s ?p ?o } ",
           "sources": [
               "https://lab1cattledata.solidcommunity.net/RDF/CattleData.ttl",
               "https://lab2cattledata.solidcommunity.net/RDF/PoultryRDF.ttl"
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
    "sparql": "SELECT * WHERE { ?s ?p ?o }",
    "sources": [
        "https://lab1cattledata.solidcommunity.net/RDF/CattleData.ttl",
        "https://lab2cattledata.solidcommunity.net/RDF/PoultryRDF.ttl"
    ]
}
```

### 3. Programmatically

#### Node.js Example

```javascript
const fetch = require('node-fetch');

const query = {
    sparql: "SELECT * WHERE { ?s ?p ?o }",
    sources: [
        "https://lab1cattledata.solidcommunity.net/RDF/CattleData.ttl",
        "https://lab2cattledata.solidcommunity.net/RDF/PoultryRDF.ttl"
    ]
};

fetch('<AZURE_FUNCTION_URL>/api/FedQuery', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify(query)
})
.then(response => response.json())
.then(data => console.log(data))
.catch(error => console.error('Error:', error));
```

#### Python Example

```python
import requests
import json

url = "<AZURE_FUNCTION_URL>/api/FedQuery"
query = {
    "sparql": "SELECT * WHERE { ?s ?p ?o }",
    "sources": [
        "https://lab1cattledata.solidcommunity.net/RDF/CattleData.ttl",
        "https://lab2cattledata.solidcommunity.net/RDF/PoultryRDF.ttl"
    ]
}

headers = {'Content-Type': 'application/json'}

response = requests.post(url, json=query, headers=headers)
print(response.json())
```

## Request Body

The POST request requires a JSON body with the following structure:

```json
{
    "sparql": "SELECT * WHERE { ?s ?p ?o }",
    "sources": [
        "https://lab1cattledata.solidcommunity.net/RDF/CattleData.ttl",
        "https://lab2cattledata.solidcommunity.net/RDF/PoultryRDF.ttl"
    ]
}
```

## Responses

- **200 OK**: Query results in JSON format.
- **400 Bad Request**: Invalid JSON or missing fields.
- **500 Internal Server Error**: An internal error occurred.

## Notes

- Replace `<AZURE_FUNCTION_URL>` with the actual URL of your Azure Function.
- Ensure that the RDF sources you provide are accessible and properly formatted.
- The function processes SPARQL queries and returns results in JSON format.

