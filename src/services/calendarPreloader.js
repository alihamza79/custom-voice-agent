/**
 * Calendar Preloader Service
 * Handles background calendar fetching and caching to eliminate latency
 */

const { createAppointmentTimer } = require('../utils/appointmentTimingLogger');
const calendarService = require('./googleCalendarService');
const sessionManager = require('./sessionManager');
const fillerResponseService = require('./fillerResponseService');
const chalk = require('chalk');

class CalendarPreloader {
  constructor() {
    this.preloadQueue = new Map(); // streamSid -> { promise, startTime, callerInfo }
    this.maxConcurrentPreloads = 3;
    this.activePreloads = 0;
    this.preloadTimeout = 30000; // 30 seconds timeout
  }

  /**
   * Start preloading calendar data in background immediately when call starts
   */
  async startPreloading(streamSid, callerInfo, sendFillerCallback = null) {
    const timer = createAppointmentTimer(`preload_${streamSid}`);
    timer.checkpoint('preload_start', 'Starting background calendar preload', { callerName: callerInfo.name });

    // Check if already cached
    const session = sessionManager.getSession(streamSid);
    if (session?.preloadedAppointments && session.preloadedAppointments.length > 0) {
      timer.checkpoint('preload_already_cached', 'Appointments already cached');
      console.log(`⚡ SKIP PRELOAD: ${session.preloadedAppointments.length} appointments already cached`);
      return session.preloadedAppointments;
    }

    // Check if already preloading
    if (this.preloadQueue.has(streamSid)) {
      timer.checkpoint('preload_already_running', 'Preload already in progress');
      console.log(`⏳ PRELOAD IN PROGRESS: Using existing preload for ${streamSid}`);
      return this.preloadQueue.get(streamSid).promise;
    }

    // Limit concurrent preloads
    if (this.activePreloads >= this.maxConcurrentPreloads) {
      timer.checkpoint('preload_queue_full', 'Too many concurrent preloads, queuing');
      return this.queuePreload(streamSid, callerInfo, sendFillerCallback);
    }

    const preloadPromise = this.executePreload(streamSid, callerInfo, sendFillerCallback, timer);
    
    this.preloadQueue.set(streamSid, {
      promise: preloadPromise,
      startTime: Date.now(),
      callerInfo
    });

    return preloadPromise;
  }

  /**
   * Execute the actual calendar preload with filler responses
   */
  async executePreload(streamSid, callerInfo, sendFillerCallback, timer) {
    this.activePreloads++;
    
    try {
      timer.checkpoint('google_calendar_start', 'Starting Google Calendar API call');
      
      // Start filler sequence while we fetch
      if (sendFillerCallback) {
        timer.checkpoint('filler_sequence_start', 'Starting calendar fetch filler sequence');
        fillerResponseService.sendImmediateFiller(streamSid, 'google_api', sendFillerCallback, true);
      }

      // Create a timeout race
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Calendar preload timeout')), this.preloadTimeout);
      });

      const fetchPromise = calendarService.getAppointments(callerInfo, true);
      
      // Race between fetch and timeout
      const appointments = await Promise.race([fetchPromise, timeoutPromise]);
      
      timer.checkpoint('calendar_data_received', 'Calendar data received successfully', { 
        appointmentCount: appointments?.length || 0 
      });

      // Cache in session immediately and ensure it persists
      sessionManager.setPreloadedAppointments(streamSid, appointments);
      timer.checkpoint('session_cached', 'Calendar data cached in session');
      
      // Double-check cache was set
      const verifySession = sessionManager.getSession(streamSid);
      console.log(`💾 CACHE VERIFIED: ${verifySession?.preloadedAppointments?.length || 0} appointments in session cache`);

      // Stop filler sequence and send success message
      fillerResponseService.stopFillerSequence(streamSid);
      if (sendFillerCallback && appointments?.length > 0) {
        const successFiller = this.getSuccessFiller(appointments.length);
        sendFillerCallback(successFiller);
      }

      timer.checkpoint('preload_complete', 'Calendar preload completed successfully');
      return appointments;

    } catch (error) {
      timer.checkpoint('preload_error', 'Calendar preload failed', { error: error.message });
      
      // Stop filler sequence and send error message
      try {
        fillerResponseService.stopFillerSequence(streamSid);
        if (sendFillerCallback) {
          const errorFiller = this.getErrorFiller();
          sendFillerCallback(errorFiller);
        }
      } catch (fillerError) {
        console.error('⚠️ Error in filler service:', fillerError.message);
      }

      // DON'T overwrite cache with empty array on timeout - preserve any existing data
      const session = sessionManager.getSession(streamSid);
      const existingAppointments = session?.preloadedAppointments || [];
      console.log(`⚠️ PRELOAD TIMEOUT: Preserving ${existingAppointments.length} existing appointments`);
      return existingAppointments;

    } finally {
      this.activePreloads--;
      this.preloadQueue.delete(streamSid);
      timer.printSummary();
    }
  }

  /**
   * Queue preload when at capacity
   */
  async queuePreload(streamSid, callerInfo, sendFillerCallback) {
    return new Promise((resolve) => {
      const checkQueue = () => {
        if (this.activePreloads < this.maxConcurrentPreloads) {
          resolve(this.executePreload(streamSid, callerInfo, sendFillerCallback, 
            createAppointmentTimer(`queued_preload_${streamSid}`)));
        } else {
          setTimeout(checkQueue, 500); // Check again in 500ms
        }
      };
      checkQueue();
    });
  }

  /**
   * Get cached appointments or wait for preload completion
   */
  async getAppointments(streamSid, callerInfo) {
    const timer = createAppointmentTimer(`get_cached_${streamSid}`);
    timer.checkpoint('cache_check_start', 'Checking for cached appointments');

    const session = sessionManager.getSession(streamSid);
    
    // PRIORITY 1: Check if already cached in session
    if (session?.preloadedAppointments && session.preloadedAppointments.length > 0) {
      timer.checkpoint('cache_hit', 'Using cached appointments from session', { 
        appointmentCount: session.preloadedAppointments.length 
      });
      console.log(chalk.green(`⚡ CACHE HIT: Using ${session.preloadedAppointments.length} cached appointments`));
      return session.preloadedAppointments;
    }

    // PRIORITY 2: Check if preload is in progress
    if (this.preloadQueue.has(streamSid)) {
      timer.checkpoint('preload_wait_start', 'Waiting for background preload to complete');
      console.log(chalk.yellow(`⏳ WAITING: Background preload in progress for ${streamSid}`));
      
      try {
        const appointments = await this.preloadQueue.get(streamSid).promise;
        timer.checkpoint('preload_wait_complete', 'Background preload completed', { 
          appointmentCount: appointments?.length || 0 
        });
        console.log(chalk.green(`✅ PRELOAD COMPLETE: ${appointments?.length || 0} appointments loaded`));
        return appointments;
      } catch (error) {
        timer.checkpoint('preload_wait_error', 'Background preload failed, falling back to direct fetch');
        console.log(chalk.red(`❌ PRELOAD FAILED: ${error.message}`));
      }
    }

    // PRIORITY 3: Start new preload if none exists
    console.log(chalk.yellow(`🚀 STARTING NEW PRELOAD: No cache or active preload found for ${streamSid}`));
    timer.checkpoint('new_preload_start', 'Starting new preload operation');
    
    const preloadPromise = this.startPreloading(streamSid, callerInfo);
    const appointments = await preloadPromise;
    
    timer.checkpoint('new_preload_complete', 'New preload completed', { appointmentCount: appointments?.length || 0 });
    return appointments;
  }

  /**
   * Get contextual filler for calendar fetching
   */
  getCalendarFetchFiller() {
    const fillers = [
      "Let me check your appointments for you",
      "I'm looking at your calendar now",
      "Just a moment while I access your schedule", 
      "Checking your upcoming appointments",
      "Let me pull up your calendar",
      "Accessing your appointment details"
    ];
    return fillers[Math.floor(Math.random() * fillers.length)];
  }

  /**
   * Get success filler after calendar fetch
   */
  getSuccessFiller(appointmentCount) {
    if (appointmentCount === 1) {
      return "I found your appointment";
    } else {
      return `I found ${appointmentCount} appointments for you`;
    }
  }

  /**
   * Get error filler for failed fetch
   */
  getErrorFiller() {
    const fillers = [
      "I'm having some trouble accessing your calendar",
      "Let me try a different approach",
      "There seems to be a delay with your calendar data"
    ];
    return fillers[Math.floor(Math.random() * fillers.length)];
  }

  /**
   * Cancel preload for a session
   */
  cancelPreload(streamSid) {
    if (this.preloadQueue.has(streamSid)) {
      console.log(chalk.yellow(`⏹️ Cancelling calendar preload for ${streamSid}`));
      this.preloadQueue.delete(streamSid);
    }
  }

  /**
   * Get preloader statistics
   */
  getStats() {
    return {
      activePreloads: this.activePreloads,
      queuedPreloads: this.preloadQueue.size,
      maxConcurrent: this.maxConcurrentPreloads
    };
  }

  /**
   * Clean up resources
   */
  cleanup() {
    this.preloadQueue.clear();
    this.activePreloads = 0;
  }
}

// Export singleton instance
module.exports = new CalendarPreloader();
