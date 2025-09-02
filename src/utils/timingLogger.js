const chalk = require('chalk');

class TimingLogger {
  constructor() {
    this.startTime = Date.now();
    this.operationStartTimes = new Map();
    this.sessionStartTime = null;
  }

  // Get current time in MM:SS.ss format
  getCurrentTime() {
    const now = Date.now();
    const elapsed = now - this.startTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = ((elapsed % 60000) / 1000).toFixed(2);
    return `${minutes.toString().padStart(2, '0')}:${seconds.padStart(5, '0')}`;
  }

  // Start timing an operation
  startOperation(operationName) {
    this.operationStartTimes.set(operationName, Date.now());
    console.log('');
    console.log(chalk.cyan(`⏱️  [${this.getCurrentTime()}] START: ${operationName}`));
  }

  // End timing an operation and show duration
  endOperation(operationName) {
    const startTime = this.operationStartTimes.get(operationName);
    if (startTime) {
      const duration = Date.now() - startTime;
      const durationFormatted = (duration / 1000).toFixed(2);
      console.log(chalk.green(`✅ [${this.getCurrentTime()}] END: ${operationName} (${durationFormatted}s)`));
      console.log('');
      this.operationStartTimes.delete(operationName);
      return duration;
    }
    return 0;
  }

  // Log a moment with timestamp
  logMoment(message, color = 'yellow') {
    const timestamp = this.getCurrentTime();
    let coloredMessage;
    
    switch (color) {
      case 'blue':
        coloredMessage = chalk.blue(`🕐 [${timestamp}] ${message}`);
        break;
      case 'green':
        coloredMessage = chalk.green(`🕐 [${timestamp}] ${message}`);
        break;
      case 'red':
        coloredMessage = chalk.red(`🕐 [${timestamp}] ${message}`);
        break;
      case 'cyan':
        coloredMessage = chalk.cyan(`🕐 [${timestamp}] ${message}`);
        break;
      case 'magenta':
        coloredMessage = chalk.magenta(`🕐 [${timestamp}] ${message}`);
        break;
      case 'yellow':
        coloredMessage = chalk.yellow(`🕐 [${timestamp}] ${message}`);
        break;
      case 'white':
        coloredMessage = chalk.white(`🕐 [${timestamp}] ${message}`);
        break;
      case 'gray':
        coloredMessage = chalk.gray(`🕐 [${timestamp}] ${message}`);
        break;
      default:
        coloredMessage = chalk.yellow(`🕐 [${timestamp}] ${message}`);
    }
    
    console.log(coloredMessage);
  }

  // Log user input
  logUserInput(transcript) {
    const timestamp = this.getCurrentTime();
    console.log(chalk.blue(`👤 [${timestamp}] USER INPUT: "${transcript}"`));
  }

  // Log model output
  logModelOutput(output, type = 'RESPONSE') {
    const timestamp = this.getCurrentTime();
    console.log(chalk.magenta(`🤖 [${timestamp}] ${type}: "${output}"`));
  }

  // Log intent classification
  logIntentClassification(intent, confidence = null) {
    const timestamp = this.getCurrentTime();
    const confidenceText = confidence ? ` (${(confidence * 100).toFixed(1)}%)` : '';
    console.log(chalk.yellow(`🎯 [${timestamp}] INTENT: ${intent}${confidenceText}`));
  }

  // Log filler word
  logFillerWord(filler) {
    const timestamp = this.getCurrentTime();
    console.log(chalk.cyan(`💬 [${timestamp}] FILLER: "${filler}"`));
  }

  // Log TTS events
  logTTSStart(text) {
    const timestamp = this.getCurrentTime();
    console.log(chalk.green(`🔊 [${timestamp}] TTS START: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`));
  }

  logTTSEnd() {
    const timestamp = this.getCurrentTime();
    console.log(chalk.green(`🔇 [${timestamp}] TTS END`));
  }

  // Log workflow events
  logWorkflowStart(workflowName) {
    const timestamp = this.getCurrentTime();
    console.log(chalk.magenta(`⚙️  [${timestamp}] WORKFLOW START: ${workflowName}`));
  }

  logWorkflowEnd(workflowName) {
    const timestamp = this.getCurrentTime();
    console.log(chalk.magenta(`🏁 [${timestamp}] WORKFLOW END: ${workflowName}`));
  }

  // Log session events
  logSessionStart(sessionId) {
    const timestamp = this.getCurrentTime();
    this.sessionStartTime = Date.now();
    console.log('');
    console.log(chalk.blue(`📞 [${timestamp}] SESSION START: ${sessionId}`));
    console.log('');
  }

  logSessionEnd() {
    if (this.sessionStartTime) {
      const timestamp = this.getCurrentTime();
      const sessionDuration = ((Date.now() - this.sessionStartTime) / 1000).toFixed(2);
      console.log('');
      console.log(chalk.blue(`📞 [${timestamp}] SESSION END (Duration: ${sessionDuration}s)`));
      console.log('');
      this.sessionStartTime = null;
    }
  }

  // Log errors
  logError(error, context) {
    const timestamp = this.getCurrentTime();
    console.log(chalk.red(`❌ [${timestamp}] ERROR in ${context}: ${error.message}`));
  }

  // Get session duration
  getSessionDuration() {
    if (this.sessionStartTime) {
      return ((Date.now() - this.sessionStartTime) / 1000).toFixed(2);
    }
    return '0.00';
  }
}

// Create a global instance
const globalTimingLogger = new TimingLogger();

module.exports = { TimingLogger, globalTimingLogger };
