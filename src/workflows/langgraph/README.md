# LangGraph Appointment Workflow

A clean, intelligent appointment management workflow based on LangGraph patterns from the Python implementation. This replaces the complex and buggy `shiftAppointmentWorkflow.js` with a more maintainable and intelligent solution.

## Key Improvements

- 🧠 **Intelligent**: Uses LangGraph state management for better conversation flow
- ⚡ **Fast**: Optimized for low latency with efficient tool routing
- 🔧 **Clean**: Follows Python LangGraph patterns with clear separation of concerns
- 🛠️ **Maintainable**: Modular structure makes it easy to extend and debug

## Architecture

```
appointmentGraph.js     # Main workflow orchestrator
├── state.js           # Clean state management
├── nodes.js           # Workflow nodes (agent, tools)
├── tools.js           # Appointment-specific tools
└── index.js           # Easy integration exports
```

## Usage

### Basic Usage (Drop-in Replacement)

```javascript
import { handleAppointmentRequest } from './workflows/langgraph/index.js';

// Handle appointment requests
const result = await handleAppointmentRequest(
  callerInfo, 
  transcript, 
  language, 
  streamSid, 
  sendFillerCallback
);

console.log(result.systemPrompt); // AI response
```

### Advanced Usage

```javascript
import { LangGraphAppointmentWorkflow } from './workflows/langgraph/index.js';

const workflow = new LangGraphAppointmentWorkflow();

// Initialize session
await workflow.initializeSession(streamSid, callerInfo, 'english');

// Process user input
const result = await workflow.processUserInput(streamSid, userInput);
```

## Integration

The workflow is designed to be a drop-in replacement for the old system:

```javascript
// OLD (complex, buggy)
import LangChainAppointmentWorkflow from './shiftAppointmentWorkflow.js';

// NEW (clean, intelligent)
import { handleAppointmentRequest } from './langgraph/index.js';
```

## Tools Available

1. **get_appointments** - Fetch and display user's appointments
2. **update_appointment** - Shift, reschedule, or cancel appointments
3. **remember_context** - Store conversation context
4. **end_call** - End the conversation gracefully

## Workflow Flow

1. User expresses intent to modify appointments
2. `get_appointments` tool fetches current appointments
3. AI matches user request to specific appointments
4. AI asks for confirmation before making changes
5. `update_appointment` executes the change
6. Success confirmation provided to user

## Performance Optimizations

- **Recursion Limit**: Set to 10 for faster execution
- **Contextual Fillers**: Smart filler messages during processing
- **Session Caching**: Efficient session state management
- **Tool Routing**: Direct routing to appropriate tools

## Error Handling

- Graceful fallbacks for tool failures
- Session recovery for network issues
- Clear error messages for users
- Comprehensive logging for debugging

## Configuration

```javascript
const config = {
  model: "gpt-4o",
  temperature: 0.7,
  maxTokens: 300,
  enableDebug: false
};
```

## Migration from Old Workflow

1. Replace imports:
   ```javascript
   // OLD
   import workflow from './shiftAppointmentWorkflow.js';
   
   // NEW
   import { handleAppointmentRequest } from './langgraph/index.js';
   ```

2. Update function calls:
   ```javascript
   // OLD
   const result = await workflow.handleShiftCancelIntent(callerInfo, transcript, language, streamSid);
   
   // NEW
   const result = await handleAppointmentRequest(callerInfo, transcript, language, streamSid);
   ```

## Testing

The workflow includes comprehensive error handling and fallbacks:

- Network failures → Graceful degradation
- Tool errors → Clear error messages
- Invalid inputs → Smart error recovery
- Session timeouts → Automatic cleanup

## Benefits Over Old Implementation

1. **Reduced Complexity**: 942 lines → ~400 lines of cleaner code
2. **Better Intelligence**: LangGraph state management vs manual state
3. **Improved Latency**: Optimized tool routing and execution
4. **Easier Debugging**: Clear node separation and logging
5. **Better Maintainability**: Modular structure following proven patterns

## Next Steps

1. Test with existing callers
2. Monitor performance metrics
3. Gradually migrate traffic from old workflow
4. Add additional appointment features as needed

