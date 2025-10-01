/**
 * OpenAI Provider
 * Implements OpenAI-compatible API calls via localhost:8000/v1
 */

const BaseProvider = require('./base-provider');

class OpenAIProvider extends BaseProvider {
  constructor(config) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'http://localhost:8000/v1'
    });
    this.providerName = 'openai';
    this.defaultModel = config.defaultModel || 'gpt-4o-mini';
  }

  /**
   * Complete a prompt using OpenAI API
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async complete(params) {
    const { prompt, model = this.defaultModel, options = {} } = params;

    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 1000,
      top_p: options.top_p || 1,
      frequency_penalty: options.frequency_penalty || 0,
      presence_penalty: options.presence_penalty || 0
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
      console.error(`OpenAI request failed: ${error.message}`);
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
          buffer = lines.pop(); // Keep incomplete line in buffer

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
   * Get available OpenAI models
   * @returns {Promise<Array<string>>}
   */
  async getModels() {
    try {
      const response = await this._request('/models', { method: 'GET' });
      return response.data?.map(m => m.id) || [];
    } catch (error) {
      console.error(`Failed to fetch models: ${error.message}`);
      return [this.defaultModel];
    }
  }

  /**
   * Estimate cost based on token usage
   * @param {Object} params
   * @returns {number}
   */
  estimateCost(params) {
    const { model = this.defaultModel, tokens = 1000 } = params;
    
    // Cost per 1K tokens (approximate, as of 2024)
    const pricing = {
      'gpt-4o': { input: 0.005, output: 0.015 },
      'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 }
    };

    const modelPricing = pricing[model] || pricing['gpt-4o-mini'];
    const inputCost = (tokens / 1000) * modelPricing.input;
    const outputCost = (tokens / 1000) * modelPricing.output;

    return inputCost + outputCost;
  }
}

module.exports = OpenAIProvider;
