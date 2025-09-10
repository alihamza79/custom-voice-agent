/**
 * Appointment Timing Logger
 * Comprehensive timing tracking for appointment workflow latency analysis
 */

const chalk = require('chalk');

class AppointmentTimingLogger {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.startTime = Date.now();
    this.checkpoints = new Map();
    this.stepTimes = [];
  }

  /**
   * Create a checkpoint with timing information
   */
  checkpoint(step, description = '', data = {}) {
    const now = Date.now();
    const elapsed = now - this.startTime;
    const stepTime = this.checkpoints.size > 0 ? 
      now - Math.max(...Array.from(this.checkpoints.values()).map(cp => cp.timestamp)) : 
      elapsed;

    const checkpoint = {
      step,
      description,
      timestamp: now,
      elapsed,
      stepTime,
      data
    };

    this.checkpoints.set(step, checkpoint);
    this.stepTimes.push(checkpoint);

    // Format and log with colors
    const timeStr = this.formatTime(elapsed);
    const stepTimeStr = this.formatTime(stepTime);
    const prefix = chalk.blue(`[${timeStr}]`);
    const stepPrefix = chalk.yellow(`(+${stepTimeStr})`);
    const sessionInfo = chalk.gray(`[${this.sessionId?.substring(0, 8) || 'unknown'}]`);
    
    let icon = '⏱️';
    let color = chalk.white;
    
    // Choose icon and color based on step type
    if (step.includes('start')) { icon = '🚀'; color = chalk.green; }
    else if (step.includes('llm') || step.includes('openai')) { icon = '🧠'; color = chalk.cyan; }
    else if (step.includes('calendar') || step.includes('google')) { icon = '📅'; color = chalk.blue; }
    else if (step.includes('tool')) { icon = '🔧'; color = chalk.magenta; }
    else if (step.includes('cache')) { icon = '⚡'; color = chalk.yellow; }
    else if (step.includes('complete') || step.includes('end')) { icon = '✅'; color = chalk.green; }
    else if (step.includes('error')) { icon = '❌'; color = chalk.red; }
    else if (step.includes('network') || step.includes('api')) { icon = '🌐'; color = chalk.blue; }
    
    const message = color(`${icon} ${step.toUpperCase()}: ${description}`);
    const dataStr = Object.keys(data).length > 0 ? chalk.gray(` | ${JSON.stringify(data)}`) : '';
    
    console.log(`${prefix} ${stepPrefix} ${sessionInfo} ${message}${dataStr}`);
    
    return checkpoint;
  }

  /**
   * Format time with appropriate units
   */
  formatTime(ms) {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      return `${(ms / 60000).toFixed(2)}m`;
    }
  }

  /**
   * Get timing summary
   */
  getSummary() {
    const totalTime = Date.now() - this.startTime;
    const steps = this.stepTimes;
    
    return {
      sessionId: this.sessionId,
      totalTime,
      stepCount: steps.length,
      steps: steps.map(step => ({
        step: step.step,
        description: step.description,
        elapsed: step.elapsed,
        stepTime: step.stepTime
      })),
      slowestStep: steps.reduce((slowest, current) => 
        current.stepTime > (slowest?.stepTime || 0) ? current : slowest, null)
    };
  }

  /**
   * Print summary with timing breakdown
   */
  printSummary() {
    const summary = this.getSummary();
    const totalTimeStr = this.formatTime(summary.totalTime);
    
    console.log(chalk.bold.white('\n' + '='.repeat(80)));
    console.log(chalk.bold.cyan(`📊 APPOINTMENT WORKFLOW TIMING SUMMARY`));
    console.log(chalk.bold.white('='.repeat(80)));
    console.log(chalk.white(`Session: ${summary.sessionId?.substring(0, 12) || 'unknown'}`));
    console.log(chalk.bold.green(`Total Time: ${totalTimeStr}`));
    console.log(chalk.white(`Steps: ${summary.stepCount}`));
    
    if (summary.slowestStep) {
      const slowestTimeStr = this.formatTime(summary.slowestStep.stepTime);
      console.log(chalk.bold.red(`Slowest Step: ${summary.slowestStep.step} (${slowestTimeStr})`));
    }
    
    console.log(chalk.bold.white('\n📈 STEP BREAKDOWN:'));
    summary.steps.forEach((step, i) => {
      const elapsed = this.formatTime(step.elapsed);
      const stepTime = this.formatTime(step.stepTime);
      const percentage = ((step.stepTime / summary.totalTime) * 100).toFixed(1);
      
      let bar = '';
      const barLength = Math.max(1, Math.round(percentage / 2));
      for (let j = 0; j < barLength; j++) {
        bar += '█';
      }
      
      const color = step.stepTime > 1000 ? chalk.red : step.stepTime > 500 ? chalk.yellow : chalk.green;
      console.log(color(`${i + 1}. [${elapsed}] (+${stepTime}) ${step.step}: ${step.description} ${percentage}% ${bar}`));
    });
    
    console.log(chalk.bold.white('='.repeat(80) + '\n'));
  }

  /**
   * Start a new sub-timer for detailed tracking
   */
  startSubTimer(name) {
    return {
      name,
      start: Date.now(),
      end: () => {
        const duration = Date.now() - this.start;
        this.checkpoint(`${name}_complete`, `Completed in ${this.formatTime(duration)}`, { duration });
        return duration;
      }
    };
  }
}

/**
 * Factory function to create timing logger
 */
function createAppointmentTimer(sessionId) {
  return new AppointmentTimingLogger(sessionId);
}

module.exports = { AppointmentTimingLogger, createAppointmentTimer };
