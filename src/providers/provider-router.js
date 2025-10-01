/**
 * Provider Router
 * Orchestrates multi-provider routing with caching and decision policies
 */

const OpenAIProvider = require('./openai-provider');
const AnthropicProvider = require('./anthropic-provider');
const VertexProvider = require('./vertex-provider');
const ResponseCache = require('../cache/response-cache');
const RoutingPolicy = require('../policies/routing-policy');

class ProviderRouter {
  constructor(config = {}) {
    this.config = config;
    
    // Initialize providers
    this.providers = {
      openai: new OpenAIProvider({
        baseUrl: config.baseUrl || 'http://localhost:8000/v1',
        apiKey: config.apiKey || process.env.API_KEY,
        defaultModel: config.openaiModel || 'gpt-4o-mini'
      }),
      anthropic: new AnthropicProvider({
        baseUrl: config.baseUrl || 'http://localhost:8000/v1',
        apiKey: config.apiKey || process.env.API_KEY,
        defaultModel: config.anthropicModel || 'claude-3-5-sonnet-20241022'
      }),
      vertex: new VertexProvider({
        baseUrl: config.baseUrl || 'http://localhost:8000/v1',
        apiKey: config.apiKey || process.env.API_KEY,
        projectId: config.vertexProjectId || 'kernel-o6',
        defaultModel: config.vertexModel || 'gemini-1.5-pro'
      })
    };

    // Initialize cache
    this.cache = new ResponseCache({
      ttl: config.cacheTtl || 3600000, // 1 hour
      maxSize: config.cacheMaxSize || 100 * 1024 * 1024, // 100 MB
      enabled: config.cacheEnabled !== false
    });

    // Initialize routing policy
    this.policy = new RoutingPolicy({
      rules: config.routingRules || [],
      defaultProvider: config.defaultProvider || 'openai',
      defaultModel: config.defaultModel || 'gpt-4o-mini',
      costLimit: config.costLimit || 0.10
    });

    // Request history for analytics
    this.requestHistory = [];
    this.maxHistorySize = 1000;
  }

  /**
   * Execute a completion request with routing and caching
   * @param {Object} params - Request parameters
   * @param {string} params.prompt - The prompt text
   * @param {Object} params.options - Additional options
   * @param {Object} params.context - Request context for routing decisions
   * @returns {Promise<Object>}
   */
  async complete(params) {
    const startTime = Date.now();
    
    try {
      // Check cache first
      const cached = this.cache.get({
        provider: params.provider,
        model: params.model,
        prompt: params.prompt,
        options: params.options
      });

      if (cached) {
        console.log('Returning cached response');
        this._recordRequest({
          ...params,
          cached: true,
          latency: Date.now() - startTime,
          success: true
        });
        return cached;
      }

      // Route to appropriate provider
      const routing = this._routeRequest(params);
      const provider = this.providers[routing.provider];

      if (!provider) {
        throw new Error(`Provider '${routing.provider}' not available`);
      }

      console.log(`Routing: ${routing.provider}/${routing.model} (${routing.reason})`);

      // Execute request
      const response = await provider.complete({
        prompt: params.prompt,
        model: routing.model,
        options: params.options || {}
      });

      // Add routing metadata
      response.routing = routing;
      response.latency = Date.now() - startTime;

      // Cache the response
      this.cache.set({
        provider: routing.provider,
        model: routing.model,
        prompt: params.prompt,
        options: params.options
      }, response);

      // Record request
      this._recordRequest({
        ...params,
        provider: routing.provider,
        model: routing.model,
        cached: false,
        latency: response.latency,
        success: true,
        tokens: response.usage?.total_tokens || 0
      });

      return response;
    } catch (error) {
      console.error(`Request failed: ${error.message}`);
      
      this._recordRequest({
        ...params,
        cached: false,
        latency: Date.now() - startTime,
        success: false,
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Stream completion with routing (no caching for streams)
   * @param {Object} params
   * @param {Function} onChunk
   * @returns {Promise<void>}
   */
  async streamComplete(params, onChunk) {
    const routing = this._routeRequest(params);
    const provider = this.providers[routing.provider];

    if (!provider) {
      throw new Error(`Provider '${routing.provider}' not available`);
    }

    console.log(`Streaming: ${routing.provider}/${routing.model} (${routing.reason})`);

    return provider.streamComplete({
      prompt: params.prompt,
      model: routing.model,
      options: params.options || {}
    }, onChunk);
  }

  /**
   * Route request to appropriate provider based on policy
   * @param {Object} params
   * @returns {Object} { provider, model, reason }
   */
  _routeRequest(params) {
    // If provider and model explicitly specified, use them
    if (params.provider && params.model) {
      return {
        provider: params.provider,
        model: params.model,
        reason: 'explicit selection'
      };
    }

    // Otherwise, use policy
    const promptLength = params.prompt?.length || 0;
    const tokenEstimate = Math.ceil(promptLength / 4); // Rough estimate

    const routing = this.policy.selectProvider({
      promptLength: tokenEstimate,
      requiresReasoning: params.context?.requiresReasoning || false,
      requiresSpeed: params.context?.requiresSpeed || false,
      budget: params.context?.budget,
      context: params.context
    });

    return routing;
  }

  /**
   * Record request in history for analytics
   * @param {Object} request
   */
  _recordRequest(request) {
    this.requestHistory.push({
      ...request,
      timestamp: Date.now()
    });

    // Keep history size bounded
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Get router statistics
   * @returns {Object}
   */
  getStats() {
    const recentRequests = this.requestHistory.slice(-100);
    
    const successCount = recentRequests.filter(r => r.success).length;
    const failureCount = recentRequests.filter(r => !r.success).length;
    const cachedCount = recentRequests.filter(r => r.cached).length;
    
    const avgLatency = recentRequests.length > 0
      ? recentRequests.reduce((sum, r) => sum + (r.latency || 0), 0) / recentRequests.length
      : 0;

    const totalTokens = recentRequests.reduce((sum, r) => sum + (r.tokens || 0), 0);

    const providerCounts = {};
    recentRequests.filter(r => r.provider).forEach(r => {
      providerCounts[r.provider] = (providerCounts[r.provider] || 0) + 1;
    });

    return {
      totalRequests: this.requestHistory.length,
      recentRequests: recentRequests.length,
      successRate: recentRequests.length > 0 ? (successCount / recentRequests.length * 100).toFixed(1) + '%' : 'N/A',
      cacheHitRate: recentRequests.length > 0 ? (cachedCount / recentRequests.length * 100).toFixed(1) + '%' : 'N/A',
      avgLatency: Math.round(avgLatency) + 'ms',
      totalTokens,
      providerUsage: providerCounts,
      cache: this.cache.getStats()
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get request history
   * @param {number} limit - Maximum number of records to return
   * @returns {Array<Object>}
   */
  getHistory(limit = 100) {
    return this.requestHistory.slice(-limit);
  }

  /**
   * Add custom routing rule
   * @param {Object} rule
   */
  addRoutingRule(rule) {
    this.policy.addRule(rule);
  }

  /**
   * Clear all custom routing rules
   */
  clearRoutingRules() {
    this.policy.clearRules();
  }
}

module.exports = ProviderRouter;
