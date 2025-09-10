/**
 * Filler Response Service
 * Handles contextual filler responses during long operations to prevent silence
 */

const chalk = require('chalk');

class FillerResponseService {
  constructor() {
    this.fillerQueues = new Map(); // streamSid -> { interval, index, responses }
    this.defaultInterval = 2500; // 2.5 seconds between fillers
    this.maxFillers = 3; // Maximum number of filler responses before stopping
  }

  /**
   * Start sending contextual filler responses during long operations
   */
  startFillerSequence(streamSid, context, sendCallback, interval = this.defaultInterval) {
    // Stop any existing filler sequence
    this.stopFillerSequence(streamSid);

    const fillerResponses = this.getContextualFillers(context);
    
    console.log(chalk.blue(`🎙️ Starting filler sequence for ${streamSid}: ${context}`));

    let currentIndex = 0;
    const fillerInterval = setInterval(() => {
      if (currentIndex >= fillerResponses.length || currentIndex >= this.maxFillers) {
        console.log(chalk.yellow(`⏹️ Filler sequence completed for ${streamSid}`));
        this.stopFillerSequence(streamSid);
        return;
      }

      const filler = fillerResponses[currentIndex];
      console.log(chalk.cyan(`💬 Sending filler ${currentIndex + 1}/${fillerResponses.length}: "${filler}"`));
      
      if (sendCallback) {
        sendCallback(filler);
      }

      currentIndex++;
    }, interval);

    this.fillerQueues.set(streamSid, {
      interval: fillerInterval,
      index: currentIndex,
      responses: fillerResponses,
      context
    });
  }

  /**
   * Send immediate filler and optionally start sequence
   */
  sendImmediateFiller(streamSid, context, sendCallback, startSequence = true) {
    const fillers = this.getContextualFillers(context);
    const immediateFiller = fillers[0];
    
    console.log(chalk.green(`⚡ Immediate filler for ${streamSid}: "${immediateFiller}"`));
    
    if (sendCallback) {
      sendCallback(immediateFiller);
    }

    if (startSequence && fillers.length > 1) {
      // Start sequence with remaining fillers after a delay
      setTimeout(() => {
        const remainingFillers = fillers.slice(1);
        this.startCustomFillerSequence(streamSid, remainingFillers, sendCallback);
      }, this.defaultInterval);
    }
  }

  /**
   * Start filler sequence with custom responses
   */
  startCustomFillerSequence(streamSid, customFillers, sendCallback, interval = this.defaultInterval) {
    this.stopFillerSequence(streamSid);

    let currentIndex = 0;
    const fillerInterval = setInterval(() => {
      if (currentIndex >= customFillers.length) {
        this.stopFillerSequence(streamSid);
        return;
      }

      const filler = customFillers[currentIndex];
      console.log(chalk.cyan(`💬 Custom filler ${currentIndex + 1}/${customFillers.length}: "${filler}"`));
      
      if (sendCallback) {
        sendCallback(filler);
      }

      currentIndex++;
    }, interval);

    this.fillerQueues.set(streamSid, {
      interval: fillerInterval,
      index: currentIndex,
      responses: customFillers,
      context: 'custom'
    });
  }

  /**
   * Stop filler sequence for a session
   */
  stopFillerSequence(streamSid) {
    if (this.fillerQueues.has(streamSid)) {
      const { interval, context } = this.fillerQueues.get(streamSid);
      clearInterval(interval);
      this.fillerQueues.delete(streamSid);
      console.log(chalk.yellow(`⏹️ Stopped filler sequence for ${streamSid} (${context})`));
    }
  }

  /**
   * Get contextual filler responses based on operation type
   */
  getContextualFillers(context) {
    const contextMap = {
      'calendar_fetch': [
        "Let me check your appointments",
        "I'm accessing your calendar now",
        "Just pulling up your schedule",
        "Almost there, checking your appointments"
      ],
      'appointment_shift': [
        "I'm working on rescheduling that for you",
        "Let me update your calendar",
        "Processing the appointment change",
        "Almost done with the update"
      ],
      'appointment_cancel': [
        "I'm cancelling that appointment for you",
        "Let me remove that from your calendar",
        "Processing the cancellation",
        "Almost done removing the appointment"
      ],
      'llm_processing': [
        "Let me think about that",
        "I'm processing your request",
        "One moment while I work on that",
        "Just a second"
      ],
      'google_api': [
        "Connecting to your calendar",
        "Accessing your Google Calendar",
        "Retrieving your calendar data",
        "Just a moment while I sync with your calendar"
      ],
      'general': [
        "One moment please",
        "Let me help you with that",
        "I'm working on that for you",
        "Just a second"
      ]
    };

    return contextMap[context] || contextMap['general'];
  }

  /**
   * Get progress-based fillers for long operations
   */
  getProgressFillers(context) {
    const progressMap = {
      'calendar_fetch': [
        "Connecting to your calendar...",
        "Loading your appointments...",
        "Almost finished retrieving your schedule...",
        "Just finishing up..."
      ],
      'appointment_update': [
        "Updating your appointment...",
        "Saving the changes...",
        "Confirming the update...",
        "Almost done..."
      ]
    };

    return progressMap[context] || this.getContextualFillers('general');
  }

  /**
   * Send progress update filler
   */
  sendProgressFiller(streamSid, context, progress, sendCallback) {
    const progressFillers = this.getProgressFillers(context);
    const fillerIndex = Math.min(Math.floor(progress * progressFillers.length), progressFillers.length - 1);
    const filler = progressFillers[fillerIndex];
    
    console.log(chalk.blue(`📊 Progress filler (${Math.round(progress * 100)}%): "${filler}"`));
    
    if (sendCallback) {
      sendCallback(filler);
    }
  }

  /**
   * Get service statistics
   */
  getStats() {
    return {
      activeFillerSequences: this.fillerQueues.size,
      sequences: Array.from(this.fillerQueues.entries()).map(([streamSid, data]) => ({
        streamSid,
        context: data.context,
        currentIndex: data.index,
        totalResponses: data.responses.length
      }))
    };
  }

  /**
   * Clean up all filler sequences
   */
  cleanup() {
    for (const streamSid of this.fillerQueues.keys()) {
      this.stopFillerSequence(streamSid);
    }
    console.log(chalk.green('🧹 Filler response service cleaned up'));
  }
}

// Export singleton instance
module.exports = new FillerResponseService();
