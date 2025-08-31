// Main graph module exports
const { 
  runCallerIdentificationGraph, 
  prewarmCallerGraph, 
  buildCallerGraph 
} = require('./callerIdentificationGraph');

const { 
  loadPhonebook, 
  identifyCaller, 
  reloadPhonebook, 
  addContact 
} = require('./utils/phonebook');

const { generatePersonalizedGreeting } = require('./utils/greetingGenerator');
const { customerIntentNode } = require('./nodes/customerIntentNode');
const { needsIntentClassification, getSimpleResponse } = require('./utils/utteranceFilter');

// Export all graph-related functionality
module.exports = {
  // Main graph functions
  runCallerIdentificationGraph,
  prewarmCallerGraph,
  buildCallerGraph,
  
  // Graph nodes
  customerIntentNode,
  
  // Phonebook utilities
  loadPhonebook,
  identifyCaller,
  reloadPhonebook,
  addContact,
  
  // Greeting utilities
  generatePersonalizedGreeting,
  
  // Utterance filtering utilities
  needsIntentClassification,
  getSimpleResponse
};
