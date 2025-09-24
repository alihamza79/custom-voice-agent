// Customer Verification Database Service - Handles database operations for customer verification responses
const databaseConnection = require('./databaseConnection');
const { globalTimingLogger } = require('../utils/timingLogger');

class CustomerVerificationDatabaseService {
  constructor() {
    this.db = null;
    this.collectionName = 'customer_verification_responses';
  }

  async getDatabase() {
    if (!this.db) {
      this.db = await databaseConnection.getConnection();
    }
    return this.db;
  }

  async getCollection() {
    const db = await this.getDatabase();
    return db.collection(this.collectionName);
  }

  // Log customer verification response
  async logCustomerResponse(responseData) {
    try {
      globalTimingLogger.startOperation('Log Customer Verification Response');
      
      const collection = await this.getCollection();
      
      const document = {
        ...responseData,
        timestamp: new Date(),
        createdAt: new Date().toISOString()
      };

      const result = await collection.insertOne(document);
      
      globalTimingLogger.endOperation('Log Customer Verification Response');
      console.log(`📊 [DB] Customer verification response logged: ${result.insertedId}`);
      
      return {
        success: true,
        id: result.insertedId,
        message: 'Customer response logged successfully'
      };
    } catch (error) {
      globalTimingLogger.logError(error, 'Log Customer Verification Response');
      console.error('❌ Error logging customer verification response:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Log appointment confirmation
  async logAppointmentConfirmation(data) {
    const responseData = {
      type: 'appointment_confirmed',
      appointmentId: data.appointmentId,
      appointmentSummary: data.appointmentSummary,
      originalTime: data.originalTime,
      newTime: data.newTime,
      customerPhone: data.customerPhone,
      teammateCallSid: data.teammateCallSid,
      status: 'confirmed',
      response: data.response || 'Customer confirmed the new appointment time',
      callDuration: data.callDuration,
      language: data.language || 'english'
    };

    return await this.logCustomerResponse(responseData);
  }

  // Log appointment rescheduling request
  async logAppointmentRescheduling(data) {
    const responseData = {
      type: 'appointment_rescheduled',
      appointmentId: data.appointmentId,
      appointmentSummary: data.appointmentSummary,
      originalTime: data.originalTime,
      customerPhone: data.customerPhone,
      teammateCallSid: data.teammateCallSid,
      status: 'rescheduling_requested',
      response: data.response || 'Customer requested to reschedule the appointment',
      callDuration: data.callDuration,
      language: data.language || 'english',
      preferredTimes: data.preferredTimes || []
    };

    return await this.logCustomerResponse(responseData);
  }

  // Log appointment cancellation
  async logAppointmentCancellation(data) {
    const responseData = {
      type: 'appointment_cancelled',
      appointmentId: data.appointmentId,
      appointmentSummary: data.appointmentSummary,
      originalTime: data.originalTime,
      customerPhone: data.customerPhone,
      teammateCallSid: data.teammateCallSid,
      status: 'cancelled',
      response: data.response || 'Customer declined the new appointment time',
      callDuration: data.callDuration,
      language: data.language || 'english',
      reason: data.reason || 'Not specified'
    };

    return await this.logCustomerResponse(responseData);
  }

  // Log unclear response
  async logUnclearResponse(data) {
    const responseData = {
      type: 'unclear_response',
      appointmentId: data.appointmentId,
      appointmentSummary: data.appointmentSummary,
      originalTime: data.originalTime,
      customerPhone: data.customerPhone,
      teammateCallSid: data.teammateCallSid,
      status: 'unclear',
      response: data.response || 'Customer response was unclear',
      callDuration: data.callDuration,
      language: data.language || 'english',
      transcript: data.transcript
    };

    return await this.logCustomerResponse(responseData);
  }

  // Get customer verification history
  async getCustomerVerificationHistory(customerPhone, limit = 10) {
    try {
      const collection = await this.getCollection();
      
      const history = await collection
        .find({ customerPhone })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

      return {
        success: true,
        data: history
      };
    } catch (error) {
      console.error('❌ Error getting customer verification history:', error);
      return {
        success: false,
        error: error.message,
        data: []
      };
    }
  }

  // Get appointment verification status
  async getAppointmentVerificationStatus(appointmentId) {
    try {
      const collection = await this.getCollection();
      
      const verification = await collection
        .findOne({ appointmentId }, { sort: { timestamp: -1 } });

      return {
        success: true,
        data: verification
      };
    } catch (error) {
      console.error('❌ Error getting appointment verification status:', error);
      return {
        success: false,
        error: error.message,
        data: null
      };
    }
  }
}

module.exports = new CustomerVerificationDatabaseService();





