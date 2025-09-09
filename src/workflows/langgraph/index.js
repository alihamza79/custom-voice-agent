/**
 * LangGraph-based Appointment Workflow
 * 
 * This is a clean, intelligent replacement for the complex shiftAppointmentWorkflow.js
 * Based on LangGraph patterns from the Python appointment-agent implementation
 */

const { LangGraphAppointmentWorkflow, default: appointmentWorkflow } = require('./appointmentGraph');
const { AppointmentAgentState, AppointmentConfiguration, AppointmentInput } = require('./state');
const { createCalendarTools } = require('./calendarTools');
const { generateResponse, executeTools, toolsCondition } = require('./nodes');

/**
 * Quick integration function for existing codebase
 * Drop-in replacement for the old workflow
 */
async function handleAppointmentRequest(callerInfo, transcript, language, streamSid, sendFillerCallback = null) {
  const { default: workflow } = require('./appointmentGraph');
  return await workflow.handleShiftCancelIntent(callerInfo, transcript, language, streamSid, sendFillerCallback);
}

/**
 * Continue existing appointment workflow
 */
async function continueAppointmentWorkflow(streamSid, transcript, sendFillerCallback = null) {
  const { default: workflow } = require('./appointmentGraph');
  return await workflow.processUserInput(streamSid, transcript, sendFillerCallback);
}

module.exports = {
  LangGraphAppointmentWorkflow,
  appointmentWorkflow,
  AppointmentAgentState,
  AppointmentConfiguration, 
  AppointmentInput,
  createCalendarTools,
  generateResponse,
  executeTools,
  toolsCondition,
  handleAppointmentRequest,
  continueAppointmentWorkflow
};
