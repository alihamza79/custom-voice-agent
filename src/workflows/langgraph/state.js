/**
 * Define the state structures for the appointment agent.
 * Following the Python LangGraph pattern with MessagesState as base.
 */

const { Annotation } = require("@langchain/langgraph");
const { BaseMessage } = require("@langchain/core/messages");

/**
 * Appointment Agent State - Clean state management following LangGraph patterns
 * This maintains message-based state similar to Python MessagesState
 */
const AppointmentAgentState = Annotation.Root({
  messages: Annotation({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  // Additional state fields can be added here if needed
  // Following the pattern from Python: simple and clean
});

/**
 * Input interface for the appointment workflow
 */
class AppointmentInput {
  constructor({ 
    streamSid, 
    callerInfo, 
    transcript, 
    language = 'english',
    sessionData = {} 
  }) {
    this.streamSid = streamSid;
    this.callerInfo = callerInfo;
    this.transcript = transcript;
    this.language = language;
    this.sessionData = sessionData;
  }
}

/**
 * Configuration for the appointment workflow
 */
class AppointmentConfiguration {
  constructor({
    model = "gpt-4o",
    temperature = 0.7,
    maxTokens = 300,
    enableDebug = false
  }) {
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.enableDebug = enableDebug;
  }

  static fromConfig(config = {}) {
    return new AppointmentConfiguration(config);
  }
}

module.exports = { AppointmentAgentState, AppointmentInput, AppointmentConfiguration };
