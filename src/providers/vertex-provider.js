/**
 * Vertex AI Provider
 * Implements Google Vertex AI calls via localhost:8000/v1 (OpenAI-compatible endpoint)
 * Assumes GCP project: kernel-o6
 */

const BaseProvider = require('./base-provider');

class VertexProvider extends BaseProvider {
  constructor(config) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'http://localhost:8000/v1'
    });
    this.providerName = 'vertex';
    this.defaultModel = config.defaultModel || 'gemini-1.5-pro';
    this.projectId = config.projectId || 'kernel-o6';
  }

  /**
   * Complete a prompt using Vertex AI (via OpenAI-compatible proxy)
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async complete(params) {
    const { prompt, model = this.defaultModel, options = {} } = params;

    // Use OpenAI-compatible format if proxied through localhost:8000
    const body = {
      model: `vertex/${model}`, // Prefix to route to Vertex
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 1000,
      // Pass GCP project ID in metadata
      metadata: {
        projectId: this.projectId
      }
    };

    try {
      const response = await this._request('/chat/completions', { body });
      
      return {
        provider: this.providerName,
        model,
        content: response.choices[0]?.message?.content || '',
        usage: response.usage,
        finishReason: response.choices[0]?.finish_reason,
        raw: response
      };
    } catch (error) {
      console.error(`Vertex AI request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Stream completion
   * @param {Object} params
   * @param {Function} onChunk
   * @returns {Promise<void>}
   */
  async streamComplete(params, onChunk) {
    const { prompt, model = this.defaultModel, options = {} } = params;

    const body = {
      model: `vertex/${model}`,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 1000,
      stream: true,
      metadata: {
        projectId: this.projectId
      }
    };

    const net = require('electron').net;
    const url = `${this.baseUrl}/chat/completions`;

    return new Promise((resolve, reject) => {
      const request = net.request({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        let buffer = '';

        response.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                resolve();
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices[0]?.delta?.content;
                if (content) {
                  onChunk(content);
                }
              } catch (e) {
                // Skip malformed chunks
              }
            }
          }
        });

        response.on('end', () => resolve());
        response.on('error', (error) => reject(error));
      });

      request.on('error', (error) => reject(error));
      request.write(JSON.stringify(body));
      request.end();
    });
  }

  /**
   * Get available Vertex AI models
   * @returns {Promise<Array<string>>}
   */
  async getModels() {
    return [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.0-pro',
      'text-bison',
      'chat-bison'
    ];
  }

  /**
   * Estimate cost based on token usage
   * @param {Object} params
   * @returns {number}
   */
  estimateCost(params) {
    const { model = this.defaultModel, tokens = 1000 } = params;
    
    // Cost per 1K characters (Vertex AI pricing, approximate)
    // Note: Vertex AI charges by characters, not tokens (roughly 4 chars = 1 token)
    const pricing = {
      'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
      'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
      'gemini-1.0-pro': { input: 0.0005, output: 0.0015 },
      'text-bison': { input: 0.001, output: 0.001 },
      'chat-bison': { input: 0.001, output: 0.001 }
    };

    const modelPricing = pricing[model] || pricing['gemini-1.5-pro'];
    const chars = tokens * 4; // Approximate conversion
    const inputCost = (chars / 1000) * modelPricing.input;
    const outputCost = (chars / 1000) * modelPricing.output;

    return inputCost + outputCost;
  }
}

module.exports = VertexProvider;
