/**
 * Customer Delay Response Workflow (Outbound)
 * 
 * This is a LangGraph-based workflow for the CUSTOMER side of delay notifications.
 * The customer receives an outbound call presenting two options.
 * 
 * Flow:
 * 1. Present delay options to customer
 * 2. Handle questions/concerns empathetically
 * 3. Get customer's choice via tool calls
 * 4. Update calendar + send SMS to teammate
 * 5. Confirm and end call
 */

const { customerDelayGraph } = require('./customerDelayGraph');

module.exports = {
  customerDelayGraph
};
