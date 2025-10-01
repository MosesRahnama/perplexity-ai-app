#!/usr/bin/env node
/**
 * Benchmark Suite for Provider Router
 * Tests latency, token usage, caching effectiveness, and routing decisions
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Mock Electron environment for standalone testing
if (!global.electron) {
  global.electron = {
    app: {
      getPath: (name) => {
        if (name === 'userData') return path.join(__dirname, '../.test-cache');
        return '/tmp';
      }
    }
  };
}

const ProviderRouter = require('../src/providers/provider-router');

// Benchmark configuration
const BENCHMARK_CONFIG = {
  warmup: 2,              // Warmup requests (not counted)
  iterations: 10,         // Requests per test
  providers: ['openai', 'anthropic', 'vertex'],
  scenarios: [
    {
      name: 'short-prompt',
      prompt: 'Hello, world!',
      description: 'Very short prompt (3 words)',
      expectedProvider: 'openai',
      expectedModel: 'gpt-4o-mini'
    },
    {
      name: 'medium-prompt',
      prompt: 'Explain the concept of quantum entanglement in physics. Include examples and real-world applications.',
      description: 'Medium prompt (~20 words)',
      expectedProvider: 'openai',
      expectedModel: 'gpt-4o-mini'
    },
    {
      name: 'reasoning-task',
      prompt: 'Solve this logic puzzle: Three boxes labeled A, B, and C contain different fruits. Box A is not next to the box with apples...',
      description: 'Reasoning-heavy task',
      context: { requiresReasoning: true, budget: 0.10 },
      expectedProvider: 'openai',
      expectedModel: 'gpt-4o'
    },
    {
      name: 'speed-task',
      prompt: 'Quick: what is 2+2?',
      description: 'Speed-critical task',
      context: { requiresSpeed: true },
      expectedProvider: 'vertex',
      expectedModel: 'gemini-1.5-flash'
    },
    {
      name: 'budget-constrained',
      prompt: 'Tell me a short joke.',
      description: 'Budget-constrained task',
      context: { budget: 0.01 },
      expectedProvider: 'anthropic',
      expectedModel: 'claude-3-5-haiku-20241022'
    }
  ]
};

class BenchmarkRunner {
  constructor() {
    this.results = [];
    this.router = null;
    this.startTime = Date.now();
  }

  /**
   * Initialize provider router
   */
  async init() {
    console.log('🔧 Initializing Provider Router...\n');
    
    this.router = new ProviderRouter({
      baseUrl: process.env.AI_SERVER_URL || 'http://localhost:8000/v1',
      apiKey: process.env.API_KEY || 'test-key',
      cacheEnabled: true,
      cacheTtl: 3600000
    });

    // Clear cache for clean benchmark
    this.router.clearCache();
  }

  /**
   * Run warmup requests
   */
  async warmup() {
    console.log('🔥 Warming up...');
    for (let i = 0; i < BENCHMARK_CONFIG.warmup; i++) {
      try {
        await this.router.complete({
          prompt: 'Warmup request',
          options: { max_tokens: 10 }
        });
        process.stdout.write('.');
      } catch (error) {
        process.stdout.write('✗');
      }
    }
    console.log(' Done\n');
  }

  /**
   * Run a single benchmark scenario
   */
  async runScenario(scenario) {
    console.log(`\n📊 Running: ${scenario.name}`);
    console.log(`   ${scenario.description}`);
    
    const scenarioResults = {
      name: scenario.name,
      description: scenario.description,
      iterations: [],
      stats: {}
    };

    for (let i = 0; i < BENCHMARK_CONFIG.iterations; i++) {
      process.stdout.write(`   [${i + 1}/${BENCHMARK_CONFIG.iterations}] `);
      
      const startTime = Date.now();
      let result;
      
      try {
        result = await this.router.complete({
          prompt: scenario.prompt,
          context: scenario.context || {},
          options: { max_tokens: 100 }
        });
        
        const endTime = Date.now();
        const latency = endTime - startTime;
        
        const iteration = {
          success: true,
          latency,
          cached: result.cached || false,
          provider: result.provider,
          model: result.model,
          tokens: result.usage?.total_tokens || 0,
          reason: result.routing?.reason
        };
        
        scenarioResults.iterations.push(iteration);
        
        const cacheIndicator = result.cached ? '💾' : '  ';
        process.stdout.write(`${cacheIndicator} ${latency}ms (${result.provider}/${result.model})\n`);
        
      } catch (error) {
        scenarioResults.iterations.push({
          success: false,
          error: error.message,
          latency: Date.now() - startTime
        });
        process.stdout.write(`✗ FAILED: ${error.message}\n`);
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Calculate statistics
    const successfulIterations = scenarioResults.iterations.filter(i => i.success);
    const cachedIterations = successfulIterations.filter(i => i.cached);
    
    if (successfulIterations.length > 0) {
      const latencies = successfulIterations.map(i => i.latency);
      const tokens = successfulIterations.map(i => i.tokens);
      
      scenarioResults.stats = {
        successRate: (successfulIterations.length / BENCHMARK_CONFIG.iterations * 100).toFixed(1) + '%',
        cacheHitRate: (cachedIterations.length / BENCHMARK_CONFIG.iterations * 100).toFixed(1) + '%',
        avgLatency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        minLatency: Math.min(...latencies),
        maxLatency: Math.max(...latencies),
        avgTokens: Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length),
        totalTokens: tokens.reduce((a, b) => a + b, 0),
        provider: successfulIterations[0]?.provider,
        model: successfulIterations[0]?.model,
        routingReason: successfulIterations[0]?.reason
      };
      
      // Validate routing
      if (scenario.expectedProvider && scenarioResults.stats.provider !== scenario.expectedProvider) {
        scenarioResults.stats.routingMismatch = true;
        scenarioResults.stats.expectedProvider = scenario.expectedProvider;
      }
      if (scenario.expectedModel && scenarioResults.stats.model !== scenario.expectedModel) {
        scenarioResults.stats.routingMismatch = true;
        scenarioResults.stats.expectedModel = scenario.expectedModel;
      }
      
      console.log(`   ✅ Success Rate: ${scenarioResults.stats.successRate}`);
      console.log(`   💾 Cache Hit Rate: ${scenarioResults.stats.cacheHitRate}`);
      console.log(`   ⏱️  Avg Latency: ${scenarioResults.stats.avgLatency}ms (${scenarioResults.stats.minLatency}-${scenarioResults.stats.maxLatency}ms)`);
      console.log(`   🎫 Avg Tokens: ${scenarioResults.stats.avgTokens}`);
      console.log(`   🎯 Routing: ${scenarioResults.stats.provider}/${scenarioResults.stats.model}`);
      
      if (scenarioResults.stats.routingMismatch) {
        console.log(`   ⚠️  Routing mismatch! Expected: ${scenario.expectedProvider}/${scenario.expectedModel}`);
      }
    } else {
      console.log(`   ✗ All iterations failed`);
    }

    this.results.push(scenarioResults);
  }

  /**
   * Run all benchmarks
   */
  async runAll() {
    await this.init();
    await this.warmup();

    for (const scenario of BENCHMARK_CONFIG.scenarios) {
      await this.runScenario(scenario);
    }

    this.generateReport();
  }

  /**
   * Generate comprehensive report
   */
  generateReport() {
    console.log('\n\n' + '='.repeat(80));
    console.log('📈 BENCHMARK REPORT');
    console.log('='.repeat(80));
    
    const totalTime = Date.now() - this.startTime;
    const routerStats = this.router.getStats();
    
    console.log('\n🔍 Overall Statistics:');
    console.log(`   Total Time: ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`   Total Requests: ${routerStats.totalRequests}`);
    console.log(`   Success Rate: ${routerStats.successRate}`);
    console.log(`   Cache Hit Rate: ${routerStats.cacheHitRate}`);
    console.log(`   Avg Latency: ${routerStats.avgLatency}`);
    console.log(`   Total Tokens: ${routerStats.totalTokens}`);
    
    console.log('\n📊 Provider Usage:');
    for (const [provider, count] of Object.entries(routerStats.providerUsage)) {
      console.log(`   ${provider}: ${count} requests`);
    }
    
    console.log('\n💾 Cache Statistics:');
    console.log(`   Enabled: ${routerStats.cache.enabled}`);
    console.log(`   Total Entries: ${routerStats.cache.totalEntries}`);
    console.log(`   Valid Entries: ${routerStats.cache.validEntries}`);
    console.log(`   Utilization: ${routerStats.cache.utilizationPercent}%`);
    
    console.log('\n📝 Scenario Results:');
    this.results.forEach(result => {
      console.log(`\n   ${result.name}:`);
      console.log(`      Success Rate: ${result.stats.successRate || 'N/A'}`);
      console.log(`      Cache Hit Rate: ${result.stats.cacheHitRate || 'N/A'}`);
      console.log(`      Avg Latency: ${result.stats.avgLatency || 'N/A'}ms`);
      console.log(`      Routing: ${result.stats.provider || 'N/A'}/${result.stats.model || 'N/A'}`);
      if (result.stats.routingMismatch) {
        console.log(`      ⚠️  Expected: ${result.stats.expectedProvider}/${result.stats.expectedModel}`);
      }
    });
    
    // Export to CSV
    this.exportCSV();
    
    // Export to JSON
    this.exportJSON();
    
    console.log('\n✅ Benchmark complete!');
    console.log(`   CSV: ${path.join(__dirname, 'results.csv')}`);
    console.log(`   JSON: ${path.join(__dirname, 'results.json')}`);
    console.log('\n' + '='.repeat(80));
  }

  /**
   * Export results to CSV
   */
  exportCSV() {
    const csvPath = path.join(__dirname, 'results.csv');
    const rows = [
      ['Scenario', 'Iteration', 'Success', 'Cached', 'Latency (ms)', 'Provider', 'Model', 'Tokens', 'Reason']
    ];

    this.results.forEach(result => {
      result.iterations.forEach((iter, idx) => {
        rows.push([
          result.name,
          idx + 1,
          iter.success ? 'PASS' : 'FAIL',
          iter.cached ? 'YES' : 'NO',
          iter.latency || 'N/A',
          iter.provider || 'N/A',
          iter.model || 'N/A',
          iter.tokens || 0,
          iter.reason || iter.error || 'N/A'
        ]);
      });
    });

    const csv = rows.map(row => row.join(',')).join('\n');
    fs.writeFileSync(csvPath, csv, 'utf8');
  }

  /**
   * Export results to JSON
   */
  exportJSON() {
    const jsonPath = path.join(__dirname, 'results.json');
    const report = {
      timestamp: new Date().toISOString(),
      config: BENCHMARK_CONFIG,
      results: this.results,
      routerStats: this.router.getStats(),
      totalTime: Date.now() - this.startTime
    };

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  }
}

// Run benchmarks
if (require.main === module) {
  const runner = new BenchmarkRunner();
  
  runner.runAll().catch(error => {
    console.error('\n❌ Benchmark failed:', error);
    process.exit(1);
  });
}

module.exports = BenchmarkRunner;
