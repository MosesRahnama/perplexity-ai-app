/**
 * Routing Policy
 * Implements decision logic for provider and model selection
 */

class RoutingPolicy {
  constructor(config = {}) {
    this.rules = config.rules || [];
    this.defaultProvider = config.defaultProvider || 'openai';
    this.defaultModel = config.defaultModel || 'gpt-4o-mini';
    this.costLimit = config.costLimit || 0.10; // $0.10 per request
  }

  /**
   * Select provider and model based on request characteristics
   * @param {Object} request - Request metadata
   * @returns {Object} { provider, model, reason }
   */
  selectProvider(request) {
    const {
      promptLength = 0,
      requiresReasoning = false,
      requiresSpeed = false,
      budget = this.costLimit,
      context = {}
    } = request;

    // Apply rules in order
    for (const rule of this.rules) {
      const match = this._evaluateRule(rule, request);
      if (match) {
        return {
          provider: rule.provider,
          model: rule.model,
          reason: rule.reason || 'matched custom rule'
        };
      }
    }

    // Default routing logic
    return this._defaultRouting(request);
  }

  /**
   * Default routing logic based on request characteristics
   * @param {Object} request
   * @returns {Object}
   */
  _defaultRouting(request) {
    const { promptLength = 0, requiresReasoning = false, requiresSpeed = false, budget = this.costLimit } = request;

    // Long context → Anthropic Claude
    if (promptLength > 8000) {
      return {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        reason: 'long context (>8k tokens) → Claude 3.5 Sonnet'
      };
    }

    // Reasoning required + budget allows → OpenAI GPT-4
    if (requiresReasoning && budget >= 0.05) {
      return {
        provider: 'openai',
        model: 'gpt-4o',
        reason: 'reasoning task → GPT-4o'
      };
    }

    // Speed required + low budget → Anthropic Haiku
    if (requiresSpeed && budget < 0.02) {
      return {
        provider: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        reason: 'speed + low budget → Claude 3.5 Haiku'
      };
    }

    // Speed required → Vertex Flash
    if (requiresSpeed) {
      return {
        provider: 'vertex',
        model: 'gemini-1.5-flash',
        reason: 'speed required → Gemini 1.5 Flash'
      };
    }

    // Default: balanced option
    return {
      provider: this.defaultProvider,
      model: this.defaultModel,
      reason: 'default (balanced cost/performance)'
    };
  }

  /**
   * Evaluate a custom rule
   * @param {Object} rule
   * @param {Object} request
   * @returns {boolean}
   */
  _evaluateRule(rule, request) {
    const { condition } = rule;
    if (!condition) return false;

    try {
      // Simple condition evaluation
      if (condition.promptLengthMin && request.promptLength < condition.promptLengthMin) {
        return false;
      }
      if (condition.promptLengthMax && request.promptLength > condition.promptLengthMax) {
        return false;
      }
      if (condition.requiresReasoning !== undefined && request.requiresReasoning !== condition.requiresReasoning) {
        return false;
      }
      if (condition.requiresSpeed !== undefined && request.requiresSpeed !== condition.requiresSpeed) {
        return false;
      }
      if (condition.budgetMax && request.budget > condition.budgetMax) {
        return false;
      }
      if (condition.tag && request.context?.tags && !request.context.tags.includes(condition.tag)) {
        return false;
      }

      return true;
    } catch (error) {
      console.error(`Error evaluating rule: ${error.message}`);
      return false;
    }
  }

  /**
   * Add a custom routing rule
   * @param {Object} rule
   */
  addRule(rule) {
    if (!rule.provider || !rule.model) {
      throw new Error('Rule must specify provider and model');
    }
    this.rules.push(rule);
  }

  /**
   * Remove all custom rules
   */
  clearRules() {
    this.rules = [];
  }

  /**
   * Get statistics about routing decisions (for monitoring)
   * @param {Array<Object>} decisions - Historical decisions
   * @returns {Object}
   */
  getStats(decisions = []) {
    const providerCounts = {};
    const modelCounts = {};
    const reasonCounts = {};

    for (const decision of decisions) {
      providerCounts[decision.provider] = (providerCounts[decision.provider] || 0) + 1;
      modelCounts[decision.model] = (modelCounts[decision.model] || 0) + 1;
      reasonCounts[decision.reason] = (reasonCounts[decision.reason] || 0) + 1;
    }

    return {
      totalDecisions: decisions.length,
      providers: providerCounts,
      models: modelCounts,
      reasons: reasonCounts
    };
  }
}

module.exports = RoutingPolicy;
