// Clean Performance Logger - Structured latency tracking
const chalk = require('chalk');

class PerformanceLogger {
  constructor() {
    this.sessionMetrics = new Map(); // streamSid -> metrics
  }

  // Start timing an operation
  startTiming(streamSid, operation) {
    if (!this.sessionMetrics.has(streamSid)) {
      this.sessionMetrics.set(streamSid, {});
    }
    const session = this.sessionMetrics.get(streamSid);
    session[operation] = { start: Date.now() };
  }

  // End timing an operation
  endTiming(streamSid, operation) {
    const session = this.sessionMetrics.get(streamSid);
    if (session && session[operation]) {
      session[operation].end = Date.now();
      session[operation].duration = session[operation].end - session[operation].start;
    }
  }

  // Log user input
  logUserInput(streamSid, input) {
    console.log(chalk.blue(`👤 USER: "${input}"`));
  }

  // Log model output
  logModelOutput(streamSid, output) {
    console.log(chalk.green(`🤖 AI: "${output}"`));
  }

  // Log filler word
  logFillerWord(streamSid, filler) {
    console.log(chalk.yellow(`💬 FILLER: "${filler}"`));
  }

  // Log performance metrics in structured format
  logPerformanceMetrics(streamSid) {
    const session = this.sessionMetrics.get(streamSid);
    if (!session) return;

    const metrics = [];
    
    if (session.stt) metrics.push(`STT latency: ${session.stt.duration}ms`);
    if (session.toolCalling) metrics.push(`Tool calling: ${session.toolCalling.duration}ms`);
    if (session.tts) metrics.push(`TTS latency: ${session.tts.duration}ms`);
    if (session.llm) metrics.push(`LLM processing: ${session.llm.duration}ms`);
    if (session.workflow) metrics.push(`Workflow: ${session.workflow.duration}ms`);

    if (metrics.length > 0) {
      console.log(chalk.green.bold(`
┌─────────────────────────────────────────┐
│ ${metrics.join(' │ ')} │
└─────────────────────────────────────────┘`));
    }
  }

  // Clear session metrics
  clearSession(streamSid) {
    this.sessionMetrics.delete(streamSid);
  }
}

module.exports = new PerformanceLogger();
