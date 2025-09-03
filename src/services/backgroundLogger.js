// Background Database Logger for Zero-Latency Audit Logging
require('dotenv').config();
const dbManager = require('./databaseConnection');

class BackgroundDatabaseLogger {
  constructor() {
    this.logQueue = [];
    this.processing = false;
    this.batchSize = parseInt(process.env.DB_LOG_BATCH_SIZE) || 10;
    this.maxRetries = parseInt(process.env.DB_MAX_RETRIES) || 3;
    this.retryDelay = parseInt(process.env.DB_RETRY_DELAY) || 1000;
    this.collectionName = process.env.MONGODB_COLLECTION_AUDIT || 'appointment_audit_log';
    this.metricsCollectionName = process.env.MONGODB_COLLECTION_METRICS || 'system_metrics';

    // Fallback storage for when database is unavailable
    this.fallbackQueue = [];
    this.maxFallbackSize = 1000;
  }

  // Zero-latency logging - never blocks the main thread
  async logAppointmentChange(changeData) {
    const logEntry = {
      ...changeData,
      timestamp: new Date(changeData.timestamp || Date.now()),
      queuedAt: new Date(),
      retryCount: 0,
      status: 'queued'
    };

    // Add to queue immediately (no await)
    this.logQueue.push(logEntry);

    // Trigger background processing
    setImmediate(() => this.processQueue());

    // Return immediately for zero latency
    return { queued: true, entryId: logEntry.timestamp.getTime() };
  }

  // Process queue in background
  async processQueue() {
    if (this.processing || this.logQueue.length === 0) return;

    this.processing = true;

    try {
      const db = await dbManager.getConnection();

      while (this.logQueue.length > 0) {
        const batch = this.logQueue.splice(0, this.batchSize);
        await this.processBatch(db, batch);
      }

      // Process any fallback items if database is back online
      if (this.fallbackQueue.length > 0) {
        await this.processFallbackQueue(db);
      }

    } catch (error) {
      console.error('❌ Background logging failed:', error.message);

      // Move failed items to fallback queue
      this.handleFailedBatch(error);
    } finally {
      this.processing = false;
    }
  }

  // Process batch of log entries
  async processBatch(db, batch) {
    const startTime = Date.now();

    try {
      // Prepare bulk operations
      const bulkOps = batch.map(entry => ({
        insertOne: {
          document: {
            ...entry,
            processedAt: new Date(),
            status: 'processed'
          }
        }
      }));

      // Execute bulk insert
      const result = await db.collection(this.collectionName)
        .bulkWrite(bulkOps, { ordered: false });

      const processingTime = Date.now() - startTime;

      console.log(`📊 Logged ${result.insertedCount} audit entries in ${processingTime}ms`);

      // Log performance metrics
      await this.logPerformanceMetric(db, {
        metricType: 'batch_audit_logging',
        timestamp: new Date(),
        duration: processingTime,
        success: true,
        metadata: {
          batchSize: batch.length,
          insertedCount: result.insertedCount
        }
      });

    } catch (error) {
      console.error('❌ Batch processing failed:', error.message);
      throw error;
    }
  }

  // Process fallback queue when database is back online
  async processFallbackQueue(db) {
    if (this.fallbackQueue.length === 0) return;

    console.log(`🔄 Processing ${this.fallbackQueue.length} fallback log entries...`);

    const batch = this.fallbackQueue.splice(0, this.batchSize);
    await this.processBatch(db, batch);
  }

  // Handle failed batch processing
  handleFailedBatch(error) {
    const failedEntries = this.logQueue.splice(0);

    // Add to fallback queue with retry metadata
    failedEntries.forEach(entry => {
      if (this.fallbackQueue.length < this.maxFallbackSize) {
        this.fallbackQueue.push({
          ...entry,
          lastError: error.message,
          retryCount: (entry.retryCount || 0) + 1,
          lastRetryAt: new Date()
        });
      }
    });

    console.warn(`⚠️ Moved ${failedEntries.length} entries to fallback queue`);
  }

  // Log performance metrics
  async logPerformanceMetric(db, metricData) {
    try {
      await db.collection(this.metricsCollectionName).insertOne(metricData);
    } catch (error) {
      console.warn('⚠️ Performance metric logging failed:', error.message);
      // Don't fail the main operation for metrics
    }
  }

  // Get audit trail for appointment
  async getAppointmentAudit(appointmentId, limit = 50) {
    try {
      const db = await dbManager.getConnection();
      return await db.collection(this.collectionName)
        .find({ appointmentId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('❌ Audit retrieval failed:', error.message);
      return [];
    }
  }

  // Get session audit trail
  async getSessionAudit(sessionId) {
    try {
      const db = await dbManager.getConnection();
      return await db.collection(this.collectionName)
        .find({ sessionId })
        .sort({ timestamp: 1 })
        .toArray();
    } catch (error) {
      console.error('❌ Session audit retrieval failed:', error.message);
      return [];
    }
  }

  // Get performance metrics
  async getPerformanceMetrics(timeRange = '1h') {
    try {
      const db = await dbManager.getConnection();
      const startTime = new Date(Date.now() - parseTimeRange(timeRange));

      const metrics = await db.collection(this.metricsCollectionName)
        .aggregate([
          { $match: { timestamp: { $gte: startTime } } },
          {
            $group: {
              _id: '$metricType',
              count: { $sum: 1 },
              avgDuration: { $avg: '$duration' },
              successRate: {
                $avg: { $cond: ['$success', 1, 0] }
              }
            }
          }
        ])
        .toArray();

      return metrics;
    } catch (error) {
      console.error('❌ Performance metrics retrieval failed:', error.message);
      return [];
    }
  }

  // Get error analysis
  async getErrorAnalysis(timeRange = '24h') {
    try {
      const db = await dbManager.getConnection();
      const startTime = new Date(Date.now() - parseTimeRange(timeRange));

      return await db.collection(this.collectionName)
        .find({
          'errors.0': { $exists: true },
          timestamp: { $gte: startTime }
        })
        .sort({ timestamp: -1 })
        .limit(100)
        .toArray();
    } catch (error) {
      console.error('❌ Error analysis failed:', error.message);
      return [];
    }
  }

  // Get queue status for monitoring
  getQueueStatus() {
    return {
      mainQueueSize: this.logQueue.length,
      fallbackQueueSize: this.fallbackQueue.length,
      isProcessing: this.processing,
      totalQueued: this.logQueue.length + this.fallbackQueue.length
    };
  }

  // Force process queue (for testing/debugging)
  async forceProcessQueue() {
    console.log('🔧 Force processing queue...');
    await this.processQueue();
  }
}

// Helper function to parse time ranges
function parseTimeRange(timeRange) {
  const unit = timeRange.slice(-1);
  const value = parseInt(timeRange.slice(0, -1));

  switch (unit) {
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'm': return value * 60 * 1000;
    case 's': return value * 1000;
    default: return 60 * 60 * 1000; // Default 1 hour
  }
}

// Singleton instance
const backgroundLogger = new BackgroundDatabaseLogger();

module.exports = backgroundLogger;
