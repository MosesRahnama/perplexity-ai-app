/**
 * Base Provider Class
 * Abstract interface for AI providers (OpenAI, Anthropic, Vertex AI)
 */

class BaseProvider {
  constructor(config) {
    if (this.constructor === BaseProvider) {
      throw new Error('BaseProvider is abstract and cannot be instantiated directly');
    }
    
    this.config = config;
    this.baseUrl = config.baseUrl || 'http://localhost:8000/v1';
    this.apiKey = config.apiKey || process.env.API_KEY;
    this.timeout = config.timeout || 30000;
  }

  /**
   * Send a completion request to the provider
   * @param {Object} params - Request parameters
   * @param {string} params.prompt - The prompt text
   * @param {string} params.model - Model identifier
   * @param {Object} params.options - Additional options (temperature, max_tokens, etc.)
   * @returns {Promise<Object>} Response object
   */
  async complete(params) {
    throw new Error('Method complete() must be implemented by subclass');
  }

  /**
   * Stream a completion request
   * @param {Object} params - Request parameters
   * @param {Function} onChunk - Callback for each chunk
   * @returns {Promise<void>}
   */
  async streamComplete(params, onChunk) {
    throw new Error('Method streamComplete() must be implemented by subclass');
  }

  /**
   * Get available models for this provider
   * @returns {Promise<Array<string>>}
   */
  async getModels() {
    throw new Error('Method getModels() must be implemented by subclass');
  }

  /**
   * Validate provider configuration
   * @returns {boolean}
   */
  validate() {
    if (!this.baseUrl) {
      throw new Error('baseUrl is required');
    }
    return true;
  }

  /**
   * Make HTTP request with timeout
   * @param {string} endpoint - API endpoint
   * @param {Object} options - Request options
   * @returns {Promise<Object>}
   */
  async _request(endpoint, options = {}) {
    const net = require('electron').net;
    
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}${endpoint}`;
      const timeout = options.timeout || this.timeout;
      
      const request = net.request({
        url,
        method: options.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          ...options.headers
        }
      });

      const timeoutId = setTimeout(() => {
        request.abort();
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      let responseData = '';

      request.on('response', (response) => {
        clearTimeout(timeoutId);

        if (response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }

        response.on('data', (chunk) => {
          responseData += chunk.toString();
        });

        response.on('end', () => {
          try {
            const data = JSON.parse(responseData);
            resolve(data);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        });
      });

      request.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      if (options.body) {
        request.write(JSON.stringify(options.body));
      }

      request.end();
    });
  }

  /**
   * Calculate cost estimate for request
   * @param {Object} params - Request parameters
   * @returns {number} Estimated cost in USD
   */
  estimateCost(params) {
    // Default implementation, override in subclasses
    return 0;
  }
}

module.exports = BaseProvider;
