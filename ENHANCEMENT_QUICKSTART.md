# 🚀 Enhancement Suite - Quick Start Guide

## Overview

This enhancement adds **multi-provider AI routing** with intelligent caching and decision policies to the Perplexity Desktop App. Route requests across OpenAI, Anthropic, and Google Vertex AI with automatic provider selection based on task characteristics.

## Features

✅ **Multi-Provider Routing**: Automatically select the best AI provider based on:
- Prompt length (long context → Claude)
- Task type (reasoning → GPT-4, speed → Gemini Flash)
- Budget constraints (cost optimization)

✅ **Intelligent Caching**: Disk-based response cache with TTL
- Reduces API costs by caching repeated queries
- 100MB default limit with LRU eviction
- 1-hour default TTL (configurable)

✅ **Decision Policy Hooks**: Customize routing rules via JSON config
- Define conditions (prompt length, budget, tags)
- Specify provider/model for matched requests
- Fallback to default policy

✅ **Cost Tracking**: Estimate and monitor API costs

---

## Prerequisites

### 1. Unified AI Server (Required)

The enhancement assumes you're running a **unified AI server** at `http://localhost:8000/v1` that provides an OpenAI-compatible API proxying to:
- OpenAI (gpt-4o, gpt-4o-mini, etc.)
- Anthropic (claude-3-5-sonnet, claude-3-5-haiku, etc.)
- Google Vertex AI (gemini-1.5-pro, gemini-1.5-flash, etc.)

#### Option A: Use LiteLLM Proxy (Recommended)

```bash
# Install LiteLLM
pip install litellm[proxy]

# Start proxy server
litellm --port 8000 \
  --model gpt-4o-mini \
  --model claude-3-5-sonnet-20241022 \
  --model vertex_ai/gemini-1.5-pro
```

#### Option B: Use OpenRouter.ai

```bash
# Set environment variable
export AI_SERVER_URL=https://openrouter.ai/api/v1
export API_KEY=your-openrouter-key
```

#### Option C: Custom Proxy

Implement your own OpenAI-compatible proxy that routes to multiple providers.

### 2. API Keys

Set up authentication in `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit `.env`:
```
API_KEY=your-unified-api-key
# OR provider-specific:
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GCP_PROJECT_ID=kernel-o6
```

---

## Installation

### 1. Dependencies Already Installed

The enhancement uses built-in Electron `net` module—no additional dependencies needed beyond the existing `dotenv` package.

### 2. Enable in Main Process

Add to `main.js` (near the top, after other requires):

```javascript
// Load environment variables
require('dotenv').config();

// Initialize Provider Router
const ProviderRouter = require('./src/providers/provider-router');
const fs = require('fs');
const path = require('path');

let providerRouter;

// Load configuration
function loadProviderConfig() {
  const configPath = path.join(__dirname, 'config.json');
  const examplePath = path.join(__dirname, 'config.example.json');
  
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config;
  } else if (fs.existsSync(examplePath)) {
    console.log('No config.json found, using defaults from config.example.json');
    return JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  }
  
  return {}; // Use defaults
}

// Initialize router when app is ready
app.on('ready', () => {
  const config = loadProviderConfig();
  
  providerRouter = new ProviderRouter({
    baseUrl: process.env.AI_SERVER_URL || config.server?.baseUrl,
    apiKey: process.env.API_KEY,
    cacheEnabled: process.env.CACHE_ENABLED !== 'false',
    cacheTtl: parseInt(process.env.CACHE_TTL || '3600000'),
    routingRules: config.routing?.rules || [],
    defaultProvider: process.env.DEFAULT_PROVIDER || config.routing?.defaultProvider,
    defaultModel: process.env.DEFAULT_MODEL || config.routing?.defaultModel
  });
  
  console.log('Provider Router initialized:', providerRouter.getStats());
  
  // ... rest of app initialization
});
```

### 3. Create Configuration (Optional)

```bash
cp config.example.json config.json
```

Edit `config.json` to customize routing rules, models, and policies.

---

## Usage Examples

### Example 1: Basic Request (Auto-Routing)

```javascript
// In main process or via IPC
const response = await providerRouter.complete({
  prompt: "Explain quantum computing in simple terms",
  options: {
    temperature: 0.7,
    max_tokens: 500
  }
});

console.log(response.content); // AI response
console.log(response.provider); // "openai" (or whichever was selected)
console.log(response.model); // "gpt-4o-mini"
console.log(response.routing.reason); // "default (balanced cost/performance)"
```

### Example 2: Explicit Provider/Model

```javascript
const response = await providerRouter.complete({
  prompt: "Write a Python function to sort a list",
  provider: "anthropic",
  model: "claude-3-5-haiku-20241022"
});
```

### Example 3: Context-Based Routing

```javascript
const response = await providerRouter.complete({
  prompt: "Analyze this 50-page legal document...",
  context: {
    requiresReasoning: true,
    requiresSpeed: false,
    budget: 0.15 // Max $0.15 per request
  }
});

// Automatically routed to Claude 3.5 Sonnet for long context
```

### Example 4: Streaming Response

```javascript
await providerRouter.streamComplete({
  prompt: "Write a story about...",
  options: { max_tokens: 2000 }
}, (chunk) => {
  process.stdout.write(chunk); // Print each chunk as it arrives
});
```

### Example 5: Get Statistics

```javascript
const stats = providerRouter.getStats();
console.log(stats);
// Output:
// {
//   totalRequests: 42,
//   successRate: "95.2%",
//   cacheHitRate: "33.3%",
//   avgLatency: "1245ms",
//   totalTokens: 125000,
//   providerUsage: { openai: 20, anthropic: 15, vertex: 7 },
//   cache: { enabled: true, totalEntries: 14, validEntries: 12, ... }
// }
```

---

## Configuration Reference

### Routing Rules

Define custom rules in `config.json`:

```json
{
  "routing": {
    "rules": [
      {
        "name": "long-documents",
        "description": "Route documents >8k tokens to Claude",
        "condition": {
          "promptLengthMin": 8000
        },
        "provider": "anthropic",
        "model": "claude-3-5-sonnet-20241022",
        "reason": "long context optimization"
      }
    ]
  }
}
```

**Available Conditions:**
- `promptLengthMin` / `promptLengthMax`: Token count range
- `requiresReasoning`: Boolean (complex reasoning tasks)
- `requiresSpeed`: Boolean (speed-critical tasks)
- `budgetMax`: Maximum cost in USD
- `tag`: Match context tags

### Cache Configuration

```json
{
  "cache": {
    "enabled": true,
    "ttl": 3600000,  // 1 hour in milliseconds
    "maxSize": 104857600  // 100 MB
  }
}
```

Or via environment variables:
```bash
CACHE_ENABLED=true
CACHE_TTL=3600000
CACHE_MAX_SIZE=104857600
```

### Security Settings

```json
{
  "security": {
    "validateInputs": true,
    "sanitizeOutputs": true,
    "maxPromptLength": 100000
  }
}
```

---

## IPC Integration (for Renderer Process)

To use the provider router from renderer processes, add IPC handlers in `main.js`:

```javascript
// In main.js
ipcMain.handle('ai-complete', async (event, params) => {
  try {
    const response = await providerRouter.complete(params);
    return { success: true, data: response };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-stats', async () => {
  return providerRouter.getStats();
});

ipcMain.on('ai-clear-cache', () => {
  providerRouter.clearCache();
});
```

In preload script (`preload.js`):

```javascript
contextBridge.exposeInMainWorld('ai', {
  complete: (params) => ipcRenderer.invoke('ai-complete', params),
  getStats: () => ipcRenderer.invoke('ai-stats'),
  clearCache: () => ipcRenderer.send('ai-clear-cache')
});
```

In renderer (`renderer.js`):

```javascript
// Make AI request
const result = await window.ai.complete({
  prompt: "Hello, world!",
  context: { requiresSpeed: true }
});

if (result.success) {
  console.log(result.data.content);
}

// Get statistics
const stats = await window.ai.getStats();
console.log(stats);
```

---

## Testing

### 1. Verify Setup

Create a test script `test-providers.js`:

```javascript
require('dotenv').config();
const ProviderRouter = require('./src/providers/provider-router');

const router = new ProviderRouter({
  baseUrl: process.env.AI_SERVER_URL || 'http://localhost:8000/v1',
  apiKey: process.env.API_KEY
});

async function test() {
  console.log('Testing provider router...\n');
  
  // Test 1: Default routing
  const response1 = await router.complete({
    prompt: "Say hello in 5 words",
    options: { max_tokens: 20 }
  });
  console.log('Test 1 - Default routing:');
  console.log(`  Provider: ${response1.provider}`);
  console.log(`  Model: ${response1.model}`);
  console.log(`  Response: ${response1.content}`);
  console.log(`  Reason: ${response1.routing.reason}\n`);
  
  // Test 2: Cache hit
  const response2 = await router.complete({
    prompt: "Say hello in 5 words",
    options: { max_tokens: 20 }
  });
  console.log('Test 2 - Cache hit:');
  console.log(`  Cached: ${response2.cached}`);
  console.log(`  Cache age: ${response2.cacheAge}ms\n`);
  
  // Test 3: Context-based routing
  const response3 = await router.complete({
    prompt: "Explain relativity in detail",
    context: { requiresReasoning: true, budget: 0.10 }
  });
  console.log('Test 3 - Context routing:');
  console.log(`  Provider: ${response3.provider}`);
  console.log(`  Model: ${response3.model}`);
  console.log(`  Reason: ${response3.routing.reason}\n`);
  
  // Stats
  const stats = router.getStats();
  console.log('Statistics:', stats);
}

test().catch(console.error);
```

Run:
```bash
node test-providers.js
```

### 2. Expected Output

```
Testing provider router...

Test 1 - Default routing:
  Provider: openai
  Model: gpt-4o-mini
  Response: Hello! How can I help?
  Reason: default (balanced cost/performance)

Cache SET: 3a5f9c1e... (size: 342 bytes)

Test 2 - Cache hit:
  Cached: true
  Cache age: 15ms

Cache HIT: 3a5f9c1e... (age: 0s)

Test 3 - Context routing:
  Provider: openai
  Model: gpt-4o
  Reason: reasoning task → GPT-4o

Statistics: {
  totalRequests: 3,
  successRate: '100.0%',
  cacheHitRate: '33.3%',
  avgLatency: '1243ms',
  totalTokens: 450,
  providerUsage: { openai: 3 },
  cache: { enabled: true, totalEntries: 2, ... }
}
```

---

## Monitoring & Debugging

### View Cache Contents

```javascript
const cacheStats = providerRouter.cache.getStats();
console.log(cacheStats);
// {
//   enabled: true,
//   totalEntries: 15,
//   validEntries: 12,
//   expiredEntries: 3,
//   totalSize: 52428800,
//   maxSize: 104857600,
//   utilizationPercent: 50,
//   cacheDir: '/home/user/.config/perplexity-ai-app/ai-cache'
// }
```

### View Request History

```javascript
const history = providerRouter.getHistory(10); // Last 10 requests
history.forEach(req => {
  console.log(`${req.provider}/${req.model}: ${req.latency}ms, cached: ${req.cached}`);
});
```

### Clear Cache

```javascript
providerRouter.clearCache();
console.log('Cache cleared');
```

---

## Troubleshooting

### Issue: "Request timeout after 30000ms"

**Solution:** Check that your AI server at `localhost:8000` is running:
```bash
curl http://localhost:8000/v1/models
```

### Issue: "Provider 'openai' not available"

**Solution:** Verify configuration and environment variables:
```bash
echo $API_KEY
echo $AI_SERVER_URL
```

### Issue: "HTTP 401: Unauthorized"

**Solution:** Check API key in `.env`:
```
API_KEY=your-actual-key-here
```

### Issue: Responses not cached

**Solution:** Verify cache is enabled:
```javascript
console.log(providerRouter.cache.enabled);
// Should be: true
```

Enable in config:
```json
{ "cache": { "enabled": true } }
```

---

## Performance Tips

1. **Use Caching Aggressively**: Set longer TTL for stable queries
   ```json
   { "cache": { "ttl": 7200000 } }  // 2 hours
   ```

2. **Optimize Routing Rules**: Put most common conditions first
   
3. **Monitor Token Usage**: Use `getStats()` to track costs
   
4. **Batch Similar Requests**: Group related queries to leverage cache

5. **Adjust TTL by Use Case**:
   - Documentation queries: Long TTL (hours)
   - Real-time data: Short TTL (minutes) or disable cache
   - Code generation: Medium TTL (1 hour)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Perplexity Desktop App                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐     ┌──────────────────────────────┐     │
│  │  main.js    │────▶│    ProviderRouter            │     │
│  └─────────────┘     │  (src/providers/provider-    │     │
│                      │         router.js)            │     │
│                      └────────────┬──────────────────┘     │
│                                   │                         │
│              ┌────────────────────┼──────────────────┐     │
│              │                    │                  │     │
│              ▼                    ▼                  ▼     │
│      ┌──────────────┐   ┌──────────────┐   ┌──────────┐  │
│      │   OpenAI     │   │  Anthropic   │   │  Vertex  │  │
│      │   Provider   │   │   Provider   │   │ Provider │  │
│      └──────┬───────┘   └──────┬───────┘   └────┬─────┘  │
│             │                   │                 │        │
│             └───────────────────┴─────────────────┘        │
│                                 │                          │
│                                 ▼                          │
│                    ┌────────────────────────┐             │
│                    │  Unified AI Server     │             │
│                    │  localhost:8000/v1     │             │
│                    └────────────────────────┘             │
│                                                            │
│  ┌──────────────────┐          ┌─────────────────────┐   │
│  │  ResponseCache   │          │  RoutingPolicy      │   │
│  │  (Disk + TTL)    │          │  (Decision Logic)   │   │
│  └──────────────────┘          └─────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

---

## Next Steps

1. ✅ Set up unified AI server at `localhost:8000/v1`
2. ✅ Copy `.env.example` to `.env` and configure
3. ✅ Copy `config.example.json` to `config.json` (optional)
4. ✅ Run test script to verify setup
5. ✅ Integrate into main app via IPC
6. ✅ Monitor stats and optimize routing rules

---

## Support

For issues or questions:
1. Check [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details
2. Review [SECURITY.md](./SECURITY.md) for security best practices
3. Consult provider documentation (OpenAI, Anthropic, Vertex AI)

---

**Version:** 1.0  
**Compatible with:** Perplexity Desktop App v4.0.1+  
**Last Updated:** 2025-01-XX
