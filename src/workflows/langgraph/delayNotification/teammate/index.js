/**
 * Teammate Delay Notification Workflow (Inbound)
 * 
 * This workflow handles when a TEAMMATE calls the bot to notify about a delay.
 * Flow:
 * 1. Extract delay info (minutes, customer name, alternative time)
 * 2. Lookup appointment in calendar
 * 3. Calculate wait time option
 * 4. Confirm with teammate
 * 5. Make outbound call to customer
 * 6. End teammate call (SMS will be sent after customer responds)
 */

const { delayNotificationGraph } = require('./delayNotificationGraph');

module.exports = {
  delayNotificationGraph
};
