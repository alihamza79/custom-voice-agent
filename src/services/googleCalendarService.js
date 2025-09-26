// Google Calendar Service with Service Account Authentication
// Optimized for 2-3 second latency with caching and parallel processing

require('dotenv').config();

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { createAppointmentTimer } = require('../utils/appointmentTimingLogger');

class GoogleCalendarService {
  constructor() {
    this.auth = null;
    this.calendar = null;
    this.isAuthenticated = false;

    // Caching for performance
    this.appointmentCache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes cache (increased from 30 seconds)
    this.lastCacheUpdate = 0;

    // Calendar ID - using Calendar_Agent calendar instead of service account's primary
    // TODO: Replace with actual Calendar_Agent calendar ID after sharing
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary'; // Will be updated to Calendar_Agent ID

    this.initializeAuth();
  }

  async initializeAuth() {
    try {
      const credentialsPath = path.join(__dirname, '../config/calender-agent.json');

      if (!fs.existsSync(credentialsPath)) {
        console.error('❌ Google credentials file not found at:', credentialsPath);
        console.error('Please download service account key from Google Cloud Console and place it there.');
        return false;
      }

      const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

      // Create GoogleAuth client for service account authentication
      // This approach works better with the credentials object
      this.auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/calendar']
      });

      console.log('🔐 GoogleAuth client created successfully');

      // Get authenticated client for API calls
      this.authClient = await this.auth.getClient();
      console.log('✅ Authenticated client obtained');

      // Create calendar client
      this.calendar = google.calendar({ version: 'v3', auth: this.authClient });
      this.isAuthenticated = true;

      console.log('✅ Google Calendar service authenticated successfully');
      return true;

    } catch (error) {
      console.error('❌ Google Calendar authentication failed:', error.message);
      this.isAuthenticated = false;
      return false;
    }
  }

  // Get cached appointments or fetch fresh data
  async getAppointments(callerInfo, forceRefresh = false) {
    const timer = createAppointmentTimer(`calendar_${callerInfo.phoneNumber}`);
    timer.checkpoint('calendar_service_start', 'Starting Google Calendar service request', { forceRefresh });
    
    // FIXED: Use only phone number for cache key to ensure consistency
    // This prevents cache misses when callerInfo.name differs between calls
    const cacheKey = callerInfo.phoneNumber;
    const now = Date.now();

    timer.checkpoint('cache_check_start', 'Checking appointment cache');
    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && this.appointmentCache.has(cacheKey)) {
      const cached = this.appointmentCache.get(cacheKey);
      if (now - cached.timestamp < this.cacheExpiry) {
        timer.checkpoint('cache_hit', 'Using cached calendar data', { age: now - cached.timestamp });
        console.log(`⚡ GOOGLE CACHE HIT: ${cached.data?.length || 0} appointments from cache for ${callerInfo.phoneNumber}`);
        return cached.data;
      } else {
        console.log(`⏰ CACHE EXPIRED: Cache age ${now - cached.timestamp}ms exceeds TTL ${this.cacheExpiry}ms`);
      }
    }
    timer.checkpoint('cache_miss', 'Cache miss or force refresh, fetching fresh data');
    console.log(`🔄 GOOGLE API FETCH: Force refresh=${forceRefresh}, Cache expired or missing`);

    // Fetch fresh data
    const appointments = await this.fetchAppointmentsFromCalendar(callerInfo);

    timer.checkpoint('cache_store_start', 'Storing fresh data in cache');
    // Cache the results
    this.appointmentCache.set(cacheKey, {
      data: appointments,
      timestamp: now
    });
    timer.checkpoint('cache_store_complete', 'Data cached successfully');

    timer.checkpoint('calendar_service_complete', 'Google Calendar service completed', { appointmentCount: appointments.length });
    return appointments;
  }

  // Fetch appointments from Google Calendar with optimized query and retry logic
  async fetchAppointmentsFromCalendar(callerInfo) {
    const timer = createAppointmentTimer(`google_api_${callerInfo.phoneNumber}`);
    
    return this.executeWithRetry(async () => {
      timer.checkpoint('google_api_start', 'Starting Google Calendar API call');
      
      if (!this.isAuthenticated) {
        throw new Error('Google Calendar service not authenticated');
      }

      timer.checkpoint('query_preparation', 'Preparing Calendar API query parameters');
      // Query for upcoming events (next 90 days for better coverage)
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

      timer.checkpoint('api_call_start', 'Making Google Calendar API request');
      // Parallel API calls for better performance
      const [eventsResponse] = await Promise.all([
        this.calendar.events.list({
          calendarId: this.calendarId,
          timeMin: timeMin,
          timeMax: timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 20, // Limit results for speed
          // q: callerInfo.name || callerInfo.phoneNumber // Search by name or phone (optional)
        })
      ]);
      timer.checkpoint('api_call_complete', 'Google Calendar API response received', { eventCount: eventsResponse.data.items?.length || 0 });

      timer.checkpoint('data_transform_start', 'Transforming Google Calendar events to our format');
      // Transform Google Calendar events to our format
      const appointments = eventsResponse.data.items.map(event => ({
        id: event.id,
        summary: event.summary,
        description: event.description || '',
        start: {
          dateTime: event.start.dateTime || event.start.date,
          timeZone: event.start.timeZone
        },
        end: {
          dateTime: event.end.dateTime || event.end.date,
          timeZone: event.end.timeZone
        },
        status: event.status,
        location: event.location || '',
        attendees: event.attendees || []
      }));
      timer.checkpoint('data_transform_complete', 'Data transformation completed', { appointmentCount: appointments.length });

      return appointments;
    }, 'fetchAppointments');
  }

  // Execute operation with exponential backoff retry logic
  async executeWithRetry(operation, operationName = 'operation', maxRetries = 3) {
    let attempt = 0;
    let lastError;

    while (attempt < maxRetries) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        attempt++;

        // Check if it's a rate limit or server error that should be retried
        const shouldRetry = this.shouldRetryError(error);

        if (!shouldRetry || attempt >= maxRetries) {
          console.error(`❌ ${operationName} failed after ${attempt} attempts:`, error.message);
          throw error;
        }

        // Calculate delay with exponential backoff and jitter
        const baseDelay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        const jitter = Math.random() * 1000; // Add up to 1 second of jitter
        const delay = baseDelay + jitter;

        console.log(`🔄 ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  // Determine if an error should trigger a retry
  shouldRetryError(error) {
    // Rate limit errors
    if (error.code === 429 || error.code === 403) {
      return true;
    }

    // Server errors (5xx)
    if (error.code >= 500 && error.code < 600) {
      return true;
    }

    // Network/timeout errors
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true;
    }

    // Google API specific errors
    if (error.message && (
      error.message.includes('quota') ||
      error.message.includes('rate limit') ||
      error.message.includes('backend') ||
      error.message.includes('temporary')
    )) {
      return true;
    }

    return false;
  }

  // Create new appointment with retry logic
  async createAppointment(appointmentData) {
    return this.executeWithRetry(async () => {
      if (!this.isAuthenticated) {
        throw new Error('Google Calendar service not authenticated');
      }

      const startTime = Date.now();

      const event = {
        summary: appointmentData.summary,
        description: appointmentData.description || '',
        start: {
          dateTime: appointmentData.startDateTime,
          timeZone: appointmentData.timeZone || 'UTC'
        },
        end: {
          dateTime: appointmentData.endDateTime,
          timeZone: appointmentData.timeZone || 'UTC'
        },
        location: appointmentData.location || '',
        attendees: appointmentData.attendees || []
      };

      const response = await this.calendar.events.insert({
        calendarId: this.calendarId,
        resource: event
      });

      const processingTime = Date.now() - startTime;
      console.log(`📅 Appointment created in ${processingTime}ms`);

      // Invalidate cache
      this.invalidateCache();

      return {
        id: response.data.id,
        summary: response.data.summary,
        start: response.data.start,
        end: response.data.end,
        status: 'created'
      };
    }, 'createAppointment');
  }

  // Update existing appointment with retry logic
  async updateAppointment(eventId, updateData) {
    const timer = createAppointmentTimer(`update_${eventId}`);
    
    return this.executeWithRetry(async () => {
      timer.checkpoint('update_start', 'Starting appointment update', { eventId });
      
      if (!this.isAuthenticated) {
        throw new Error('Google Calendar service not authenticated');
      }

      timer.checkpoint('api_update_start', 'Making Google Calendar update API call');
      const response = await this.calendar.events.patch({
        calendarId: this.calendarId,
        eventId: eventId,
        resource: updateData
      });
      timer.checkpoint('api_update_complete', 'Google Calendar update API call completed');

      timer.checkpoint('cache_invalidate_start', 'Invalidating appointment cache');
      // Invalidate cache
      this.invalidateCache();
      timer.checkpoint('cache_invalidate_complete', 'Cache invalidated');

      timer.checkpoint('update_complete', 'Appointment update completed successfully');
      return {
        id: response.data.id,
        summary: response.data.summary,
        start: response.data.start,
        end: response.data.end,
        status: 'updated'
      };
    }, 'updateAppointment');
  }

  // Cancel/delete appointment with retry logic
  async cancelAppointment(eventId) {
    const timer = createAppointmentTimer(`cancel_${eventId}`);
    
    return this.executeWithRetry(async () => {
      timer.checkpoint('cancel_start', 'Starting appointment cancellation', { eventId });
      
      if (!this.isAuthenticated) {
        throw new Error('Google Calendar service not authenticated');
      }

      timer.checkpoint('api_cancel_start', 'Making Google Calendar delete API call');
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId: eventId
      });
      timer.checkpoint('api_cancel_complete', 'Google Calendar delete API call completed');

      timer.checkpoint('cache_invalidate_start', 'Invalidating appointment cache');
      // Invalidate cache
      this.invalidateCache();
      timer.checkpoint('cache_invalidate_complete', 'Cache invalidated');

      timer.checkpoint('cancel_complete', 'Appointment cancellation completed successfully');
      return { status: 'cancelled', eventId };
    }, 'cancelAppointment');
  }

  // Invalidate cache when data changes
  invalidateCache() {
    console.log('🗑️ Invalidating calendar cache');
    this.appointmentCache.clear();
    this.lastCacheUpdate = 0;
  }

  // Get appointment by ID with caching
  async getAppointmentById(eventId) {
    if (!this.isAuthenticated) {
      throw new Error('Google Calendar service not authenticated');
    }

    try {
      const response = await this.calendar.events.get({
        calendarId: this.calendarId,
        eventId: eventId
      });

      return {
        id: response.data.id,
        summary: response.data.summary,
        start: response.data.start,
        end: response.data.end,
        status: response.data.status
      };

    } catch (error) {
      console.error('❌ Error fetching appointment:', error.message);
      return null;
    }
  }

  // Health check for calendar service
  async healthCheck() {
    try {
      console.log('🔍 Health check - isAuthenticated:', this.isAuthenticated);
      console.log('🔍 Health check - calendar exists:', !!this.calendar);
      console.log('🔍 Health check - authClient exists:', !!this.authClient);

      if (!this.isAuthenticated) {
        return { status: 'not_authenticated', latency: 0 };
      }

      if (!this.calendar) {
        return { status: 'calendar_not_initialized', latency: 0 };
      }

      const startTime = Date.now();
      const result = await this.calendar.calendarList.list({ maxResults: 1 });
      const latency = Date.now() - startTime;

      console.log('✅ Health check successful, found calendars:', result.data.items?.length || 0);

      return {
        status: 'healthy',
        latency: latency,
        cacheSize: this.appointmentCache.size,
        calendarCount: result.data.items?.length || 0
      };

    } catch (error) {
      console.error('❌ Health check failed:', error.message);
      return {
        status: 'unhealthy',
        error: error.message,
        latency: 0
      };
    }
  }
}

module.exports = new GoogleCalendarService();
