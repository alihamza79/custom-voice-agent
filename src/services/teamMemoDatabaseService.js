require('dotenv').config();
const { ObjectId } = require('mongodb');
const databaseConnection = require('./databaseConnection');
const { globalTimingLogger } = require('../utils/timingLogger');

class TeamMemoDatabaseService {
  constructor() {
    this.collectionName = 'team_memos';
    this.db = null;
  }

  async getCollection() {
    if (!this.db) {
      this.db = await databaseConnection.getConnection();
    }
    return this.db.collection(this.collectionName);
  }

  async createMemo(data) {
    try {
      const collection = await this.getCollection();
      const result = await collection.insertOne({
        ...data,
        createdAt: new Date(),
        status: 'active'
      });
      globalTimingLogger.logMoment(`Created team memo in DB: ${result.insertedId}`);
      return { success: true, id: result.insertedId };
    } catch (error) {
      globalTimingLogger.logError(error, 'Create Team Memo in DB');
      console.error('Error creating team memo:', error);
      return { success: false, error: error.message };
    }
  }

  async getMemosByTeammate(teammateId, limit = 10) {
    try {
      const collection = await this.getCollection();
      const memos = await collection
        .find({ teammateId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
      return { success: true, memos };
    } catch (error) {
      globalTimingLogger.logError(error, 'Get Team Memos by Teammate');
      console.error('Error getting team memos:', error);
      return { success: false, error: error.message };
    }
  }

  async getMemosByTopic(topicId, limit = 10) {
    try {
      const collection = await this.getCollection();
      const memos = await collection
        .find({ topicId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
      return { success: true, memos };
    } catch (error) {
      globalTimingLogger.logError(error, 'Get Team Memos by Topic');
      console.error('Error getting team memos by topic:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new TeamMemoDatabaseService();


