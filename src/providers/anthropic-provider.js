/**
 * Anthropic Provider
 * Implements Claude API calls via localhost:8000/v1 (OpenAI-compatible endpoint)
 */

const BaseProvider = require('./base-provider');

class AnthropicProvider extends BaseProvider {
  constructor(config) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'http://localhost:8000/v1'
    });
    this.providerName = 'anthropic';
    this.defaultModel = config.defaultModel || 'claude-3-5-sonnet-20241022';
  }

  /**
   * Complete a prompt using Claude API
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async complete(params) {
    const { prompt, model = this.defaultModel, options = {} } = params;

    // Use OpenAI-compatible format if proxied through localhost:8000
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 1000
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
      console.error(`Anthropic request failed: ${error.message}`);
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
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 1000,
      stream: true
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
   * Get available Claude models
   * @returns {Promise<Array<string>>}
   */
  async getModels() {
    return [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307'
    ];
  }

  /**
   * Estimate cost based on token usage
   * @param {Object} params
   * @returns {number}
   */
  estimateCost(params) {
    const { model = this.defaultModel, tokens = 1000 } = params;
    
    // Cost per 1M tokens (approximate, as of 2024)
    const pricing = {
      'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
      'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },
      'claude-3-opus-20240229': { input: 15.0, output: 75.0 },
      'claude-3-sonnet-20240229': { input: 3.0, output: 15.0 },
      'claude-3-haiku-20240307': { input: 0.25, output: 1.25 }
    };

    const modelPricing = pricing[model] || pricing['claude-3-5-sonnet-20241022'];
    const inputCost = (tokens / 1000000) * modelPricing.input;
    const outputCost = (tokens / 1000000) * modelPricing.output;

    return inputCost + outputCost;
  }
}

module.exports = AnthropicProvider;
