// Router - Main entry point for graph-based voice agent workflows
// Refactored to use modular graph architecture

const {
  runCallerIdentificationGraph,
  prewarmCallerGraph,
  loadPhonebook,
  identifyCaller,
  reloadPhonebook,
  addContact
} = require('./src/graph');

// Main function to run the caller identification workflow
// Maintains backward compatibility with existing code
async function runMeetingGraph(input) {
  return await runCallerIdentificationGraph(input);
}

// Prewarm function to compile graphs at startup
// Maintains backward compatibility with existing code
async function prewarmMeetingGraph() {
  try {
    await prewarmCallerGraph();
    loadPhonebook(); // Also load phonebook
  } catch (e) {
    console.error('❌ Prewarm error:', e);
  }
}

// Export functions maintaining backward compatibility
module.exports = { 
  runMeetingGraph, 
  prewarmMeetingGraph, 
  identifyCaller,
  reloadPhonebook,
  addContact
};