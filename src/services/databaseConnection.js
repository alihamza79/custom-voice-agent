// Database Connection Manager for Zero-Latency Logging
require('dotenv').config();
const { MongoClient } = require('mongodb');

class DatabaseConnectionManager {
  constructor() {
    this.client = null;
    this.db = null;
    this.isConnected = false;
    this.connectionPromise = null;
    this.lastHealthCheck = 0;
    this.healthCheckInterval = 30000; // 30 seconds
  }

  async getConnection() {
    // Return existing connection if healthy
    if (this.client && this.db && this.isConnected && this.isHealthy()) {
      return this.db;
    }

    // Return pending connection if already connecting
    if (this.connectionPromise) {
      return await this.connectionPromise;
    }

    // Create new connection
    this.connectionPromise = this.createConnection();
    try {
      this.db = await this.connectionPromise;
      this.isConnected = true;
      this.lastHealthCheck = Date.now();
      console.log('✅ Database connection established');
      return this.db;
    } catch (error) {
      this.connectionPromise = null;
      this.isConnected = false;
      console.error('❌ Database connection failed:', error.message);
      throw error;
    }
  }

  async createConnection() {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is required');
    }

    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: parseInt(process.env.DB_CONNECTION_POOL_SIZE) || 5,
      serverSelectionTimeoutMS: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 5000,
      socketTimeoutMS: parseInt(process.env.DB_OPERATION_TIMEOUT) || 30000,
      maxIdleTimeMS: 30000,
      // Enable retryable writes for consistency
      retryWrites: true,
      retryReads: true
    });

    await client.connect();
    const db = client.db(process.env.MONGODB_DATABASE || 'voice-agent-audit');

    // Initialize indexes for performance
    await this.initializeIndexes(db);

    this.client = client;
    return db;
  }

  async initializeIndexes(db) {
    try {
      // Appointment audit log indexes
      await db.collection(process.env.MONGODB_COLLECTION_AUDIT || 'appointment_audit_log')
        .createIndex({ sessionId: 1, timestamp: -1 });
      await db.collection(process.env.MONGODB_COLLECTION_AUDIT || 'appointment_audit_log')
        .createIndex({ appointmentId: 1, operation: 1, timestamp: -1 });
      await db.collection(process.env.MONGODB_COLLECTION_AUDIT || 'appointment_audit_log')
        .createIndex({ callerId: 1, timestamp: -1 });
      await db.collection(process.env.MONGODB_COLLECTION_AUDIT || 'appointment_audit_log')
        .createIndex({ operation: 1, 'changeMetadata.shiftType': 1, timestamp: -1 });

      // System metrics indexes
      await db.collection(process.env.MONGODB_COLLECTION_METRICS || 'system_metrics')
        .createIndex({ metricType: 1, timestamp: -1 });
      await db.collection(process.env.MONGODB_COLLECTION_METRICS || 'system_metrics')
        .createIndex({ timestamp: -1, duration: 1 });

      console.log('✅ Database indexes initialized');
    } catch (error) {
      console.warn('⚠️ Index initialization failed:', error.message);
      // Don't fail the connection for index issues
    }
  }

  isHealthy() {
    const now = Date.now();
    return (now - this.lastHealthCheck) < this.healthCheckInterval;
  }

  async healthCheck() {
    try {
      if (!this.client) return false;

      await this.client.db().admin().ping();
      this.lastHealthCheck = Date.now();
      return true;
    } catch (error) {
      this.isConnected = false;
      return false;
    }
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.isConnected = false;
      console.log('✅ Database connection closed');
    }
  }

  // Graceful shutdown
  async gracefulShutdown() {
    console.log('🔄 Database graceful shutdown...');
    await this.close();
  }
}

// Singleton instance
const dbManager = new DatabaseConnectionManager();

// Handle process termination
process.on('SIGINT', () => dbManager.gracefulShutdown());
process.on('SIGTERM', () => dbManager.gracefulShutdown());

module.exports = dbManager;
