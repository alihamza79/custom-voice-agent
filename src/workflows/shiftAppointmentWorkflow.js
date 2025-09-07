// LangChain-Based Appointment Workflow with Memory and Tool Calling
// Fixed version with proper workflow handling

// Enable LangSmith tracing for debugging (set LANGCHAIN_TRACING_V2=true)
if (process.env.LANGCHAIN_TRACING_V2 === 'true') {
  console.log('🔍 LangSmith tracing enabled for debugging');
}

const { ChatOpenAI } = require("@langchain/openai");
const { BufferMemory } = require("langchain/memory");
const { DynamicTool, DynamicStructuredTool } = require("@langchain/core/tools");
const { AgentExecutor, createOpenAIFunctionsAgent } = require("langchain/agents");
const { ChatPromptTemplate, MessagesPlaceholder } = require("@langchain/core/prompts");
const { HumanMessage, AIMessage, SystemMessage } = require("@langchain/core/messages");
const { z } = require("zod");
const { google } = require('googleapis');
const { MongoClient } = require('mongodb');
const twilio = require('twilio');
const calendarService = require('../services/googleCalendarService');
const { getTools: getCalendarTools } = require('../services/simpleCalendarTools');
const sessionManager = require('../services/sessionManager');

class LangChainAppointmentWorkflow {
  constructor() {
    this.sessions = new Map();
    this.calendar = null;
    this.twilioClient = null;
    this.mongoClient = null;
    // REMOVED: this.appointmentCache - now per-caller via sessionManager
    this.cacheExpiry = 5 * 60 * 1000;
  }

  // Initialize a new session with memory and tools
  async initializeSession(sessionId, callerInfo, language = 'english', initialIntent = null) {
    console.log(`🧠 Initializing LangChain session: ${sessionId}`);

    // Create LLM instance optimized for natural conversations
    const llm = new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0.8, // Lower temperature for more focused responses
      streaming: false,
      maxTokens: 300, // Reasonable limit for phone conversations
      topP: 0.9,
      // LangSmith configuration for debugging
      tags: [`session-${sessionId}`, 'appointment-workflow'],
      metadata: {
        caller: callerInfo.name,
        phone: callerInfo.phoneNumber,
        language: language
      }
    });


    // Use BufferMemory for more reliable memory management
    const memory = new BufferMemory({
      memoryKey: "chat_history",
      returnMessages: true,
      inputKey: "input",
      outputKey: "output",
    });

    // Initialize memory with caller context
    const systemContext = `You are helping ${callerInfo.name} (${callerInfo.phoneNumber}) with their appointments.
Current context:
- Caller type: ${callerInfo.type}
- Language: ${language}
- Initial request: ${initialIntent || 'Not specified'}`;

    await memory.saveContext(
      { input: "System initialization" },
      { output: systemContext }
    );

    // Create tools for the agent
    const tools = await this.createTools(sessionId, callerInfo);

    // Get actual appointments and working memory for dynamic prompt
    const session = sessionManager.getSession(sessionId.replace('session_', ''));
    let appointmentContext = '';
    if (session.preloadedAppointments && session.preloadedAppointments.length > 0) {
      const appointmentList = session.preloadedAppointments.map((apt, i) => {
        const date = new Date(apt.start.dateTime);
        return `${i + 1}. "${apt.summary}" (ID: ${apt.id}) - ${date.toDateString()} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }).join('\n');
      appointmentContext = `\n\nCURRENT APPOINTMENTS FOR ${callerInfo.name}:\n${appointmentList}`;
    }

    // Get working memory context
    let workingMemoryContext = '';
    if (session.workingMemory && Object.keys(session.workingMemory).length > 0) {
      const memory = session.workingMemory;
      workingMemoryContext = `\n\n🧠 CONVERSATION CONTEXT (what user already told you):`;
      if (memory.meetingName) workingMemoryContext += `\n- Meeting they want to change: ${memory.meetingName}`;
      if (memory.action) workingMemoryContext += `\n- What they want to do: ${memory.action}`;
      if (memory.newDate) workingMemoryContext += `\n- New date they mentioned: ${memory.newDate}`;
      if (memory.newTime) workingMemoryContext += `\n- New time they mentioned: ${memory.newTime}`;
      if (memory.notes) workingMemoryContext += `\n- Additional context: ${memory.notes}`;
      workingMemoryContext += `\n\n⚠️ DO NOT ask for information already provided above!`;
    }

    // Natural conversation prompt - let GPT-4o be intelligent
    const prompt = ChatPromptTemplate.fromMessages([
      new SystemMessage(`You are a helpful appointment assistant.

🎯 YOUR ROLE: Help manage appointments naturally through conversation.

🧠 MEMORY AWARENESS: You have access to the full conversation history. ALWAYS review previous messages to:
- Avoid repeating questions already asked
- Use information already provided by the user
- Build upon previous responses instead of starting over
- Maintain conversation continuity and context

🛠️ AVAILABLE TOOLS:
1. check_calendar - Get all upcoming meetings (USE IMMEDIATELY when user wants to shift/cancel)
2. process_appointment - Update a specific meeting (shift/cancel) WITH CONFIRMATION
3. end_call - End the conversation

🔥 CRITICAL WORKFLOW SEQUENCE:
- When user mentions ANY meeting name → ALWAYS call check_calendar FIRST to get appointment data
- Then use the appointment data to match the meeting name
- NEVER try to match meeting names without calling check_calendar first!
- This is the ONLY way to get the actual appointment titles for matching!

🚨 CRITICAL FIRST RESPONSE RULE:
- If user says "I want to shift appointment" → IMMEDIATELY call check_calendar to show ALL appointments
- If user says "Can you shift an appointment for me?" → IMMEDIATELY call check_calendar to show ALL appointments
- If user says "I want to change an appointment" → IMMEDIATELY call check_calendar to show ALL appointments
- If user says "I need to reschedule" → IMMEDIATELY call check_calendar to show ALL appointments
- NEVER ask "which appointment" without first showing the list!
- NEVER show error messages or ask for clarification when user wants to shift appointments!
- ALWAYS show appointments first, then ask which one to shift!

🚨 CRITICAL DIRECT REQUEST RULE:
- If user says "I want to delay [meeting name] by [time]" → IMMEDIATELY call check_calendar first, then process that specific meeting!
- If user says "I want to shift [meeting name] by [time]" → IMMEDIATELY call check_calendar first, then process that specific meeting!
- NEVER give fallback response when user provides complete meeting name and time change!
- ALWAYS recognize complete requests like "I want to delay the dental checkup meeting by 2 days"!
- 🔥 CRITICAL: You MUST call check_calendar to get appointment data BEFORE trying to match meeting names!

💬 CONVERSATION STYLE:
- Be direct and helpful
- Use chat history to remember what was discussed
- Ask clarifying questions only when needed
- Don't be robotic or follow rigid patterns
- NEVER use the caller's name except in initial greeting

🧠 CRITICAL CONVERSATION RULES:
- ALWAYS read the FULL chat history before responding
- If user mentions a specific meeting name, ACKNOWLEDGE it immediately
- Don't ask for information the user already provided
- Progress the conversation forward, don't repeat questions
- EXTRACT INFO FROM ANY GRAMMAR: "could be", "should be", "would be" - ALL MEAN THE SAME THING
- Don't be picky about perfect English - users may not be native speakers

🚨 IMMEDIATE PROCESSING RULE:
- The MOMENT user provides date/time info → PROCESS IT IMMEDIATELY
- Don't ignore their input and ask the same question again
- If they said "22 September" → you now know the date is September 22
- If they said "2PM" → you now know the time is 2:00 PM
- ACKNOWLEDGE what they told you and move to next step or call tool!

WORKFLOW - SMART PROGRESSION:
1. User wants to shift meeting → IMMEDIATELY use check_calendar to show ALL appointment options
2. When user mentions ANY meeting name (dental, school, etc.) → ACCEPT IT and ask for date/time
3. Collect missing info step by step: date first, then time
4. 🔥 CRITICAL: When you have meeting name + date + time → ALWAYS CONFIRM BEFORE MAKING CHANGES!
   - Say: "I'm going to shift your {meeting_name} from {original_date} to {new_date} at {new_time}. Should I confirm this change?"
   - WAIT for user confirmation before calling process_appointment tool
   - If user says yes/confirm/okay/sure → THEN call process_appointment
   - If user says no/wait/change/stop → STOP and ask what they want to modify
   - If user input is unclear → say "Sorry, your input is not clear. Can you please repeat what you'd like to do?"
5. Handle relative time phrases intelligently:
   - "2 days next" = 2 days from original date, ask for time confirmation
   - "delay by 2 hours" = same date, 2 hours later, ask for date confirmation  
   - "postpone by 1 week" = 1 week from original date, ask for time confirmation
   - "move to next week" = confirm specific day and time
   - "shift to tomorrow" = confirm specific time
   - "change time to afternoon" = confirm specific time like 2PM, 3PM
6. If they say goodbye → use end_call

🚨 CRITICAL RULES TO PREVENT REPETITION:
- If user says "I want to shift [specific meeting name]" → DON'T ask "Which appointment would you like to shift?"
- If user says "I want to shift" (no specific name) → THEN show appointments and ask "Which one?"
- If user already specified meeting name → MOVE TO DATE/TIME collection immediately
- NEVER ask the same question twice in a row

⚠️ CRITICAL TOOL CALLING RULES:
- If user provides ANY date (22 September, tomorrow, next week) → IMMEDIATELY acknowledge and ask for time
- If user provides ANY time (2PM, 1 o'clock, afternoon) → ASK FOR CONFIRMATION BEFORE CALLING TOOL!
- NEVER ignore user input - ALWAYS process what they just said
- NEVER ask the same question twice - if user answered, MOVE FORWARD
- Don't say "could you please" if they already told you - USE WHAT THEY SAID!
- ALWAYS CONFIRM before making ANY changes to appointments
- If user says "No" to confirmation → STOP and ask what they want to change
- If user input is unclear or confusing → ask for clarification

CONVERSATION INTELLIGENCE & MEETING NAME MATCHING:
- Use SIMILARITY MATCHING for meeting names - don't require exact match!
- "dental" or "dental checkup" or "dental checkup meeting" → "Dental Checkup Meeting"
- "school" or "teacher meeting" or "school parent teacher meeting" or "parent teacher" → "School Parent Teacher Meeting"
- "business" or "business meeting" → "Business Meeting"
- Match partial names: "I want to delay dental checkup meeting by 2 days" = CLEAR REQUEST!
- If user says "first appointment" → they mean the first appointment in the list
- If user says "last appointment" → they mean the last appointment in the list
- If user says "second appointment" → they mean the second appointment in the list
- Don't keep asking "which meeting" if they already told you the specific meeting name or position
- MOVE FORWARD in the conversation, don't go backwards

🎯 STT MISHEARING FIXES:
- "ship" = "shift" (common STT error)
- "I want to ship dental checkup appointment" = "I want to shift dental checkup appointment"
- "ship the meeting" = "shift the meeting"
- Always interpret "ship" as "shift" in appointment context

🚨 CRITICAL MEETING NAME PROCESSING (IMMEDIATE ACTION REQUIRED):
- "I want to shift school parent teacher meeting" → IMMEDIATELY process: "I understand you want to shift your School Parent Teacher Meeting. What date would you like to move it to?"
- "I want to delay dental checkup meeting by 2 days" → IMMEDIATELY process: "I understand you want to delay your Dental Checkup Meeting by 2 days. This will move it from [current date] to [new date]. Should I confirm this change?"
- "shift the school meeting" → IMMEDIATELY match to "School Parent Teacher Meeting" and ask for new date
- "delay the dental appointment by 3 days" → Match to "Dental Checkup Meeting" and process
- "the dental checkup meeting to 17 September" → IMMEDIATELY process: "I understand you want to shift your Dental Checkup Meeting to September 17th. What time would you prefer?"
- "dental checkup meeting to seventeenth September" → IMMEDIATELY process: "I understand you want to shift your Dental Checkup Meeting to September 17th. What time would you prefer?"
- ALWAYS include TIME CALCULATION in confirmation: "2 days delay" = show exact dates

🔥 SPECIFIC EXAMPLES FROM LOGS:
- User: "Can you shift an appointment for me?" → IMMEDIATELY call check_calendar, then show appointments list
- User: "I want to shift an appointment" → IMMEDIATELY call check_calendar, then show appointments list
- User: "the dental checkup meeting to 17 September" → IMMEDIATELY call check_calendar, then process Dental Checkup Meeting shift to Sept 17
- User: "I want to shift the dental checkup meeting to seventeenth September" → IMMEDIATELY call check_calendar, then process Dental Checkup Meeting shift to Sept 17
- User: "school parent teacher meeting by 2 days" → IMMEDIATELY call check_calendar, then process School Parent Teacher Meeting delay by 2 days
- User: "delay the dental checkup meeting by 3 days" → IMMEDIATELY call check_calendar, then process Dental Checkup Meeting delay by 3 days
- User: "shift school meeting by 1 day" → IMMEDIATELY call check_calendar, then process School Parent Teacher Meeting shift by 1 day
- User: "I want to delay the dental checkup meeting by 2 days." → IMMEDIATELY call check_calendar, then process Dental Checkup Meeting delay by 2 days
- User: "I want to delay school parent teacher meeting by 3 days." → IMMEDIATELY call check_calendar, then process School Parent Teacher Meeting delay by 3 days
- User: "I want to shift the dental checkup meeting by 1 day." → IMMEDIATELY call check_calendar, then process Dental Checkup Meeting shift by 1 day
- User: "Basically, I want to delay the dental checkup meeting by 2 days at same time." → IMMEDIATELY call check_calendar, then process Dental Checkup Meeting delay by 2 days
- User: "Yes. Confirm it." → IMMEDIATELY execute the change
- User: "Yes. I confirm it." → IMMEDIATELY execute the change
- User: "Sure. You can confirm it." → IMMEDIATELY execute the change
- User: "Time will be same. Don't change it." → KEEP SAME TIME and proceed

🎯 MODULAR MEETING NAME MATCHING (DYNAMIC RECOGNITION):
- Use FUZZY MATCHING to find the best match from available appointments
- If user says ANY words that appear in appointment titles → MATCH IT!
- Examples of matching patterns:
  * "dental" → matches "Dental Checkup Meeting" ✅
  * "school" → matches "School Parent Teacher Meeting" ✅
  * "teacher" → matches "School Parent Teacher Meeting" ✅
  * "parent" → matches "School Parent Teacher Meeting" ✅
  * "checkup" → matches "Dental Checkup Meeting" ✅
  * "meeting" → matches any meeting (use context to determine which)
  * "appointment" → matches any appointment (use context to determine which)

🔥 CRITICAL RULE: If user mentions ANY WORD that appears in ANY appointment title → IMMEDIATELY identify and proceed!
🔥 NEVER ask "Which appointment?" if user mentioned ANY part of a meeting name!

🚨 CONVERSATION CONTEXT AWARENESS:
- If user mentions a specific meeting name in their request → use that exact meeting
- If user says "delay the dental checkup meeting" → process "Dental Checkup Meeting"
- If user says "school parent teacher meeting" → process "School Parent Teacher Meeting"
- ALWAYS use the meeting name the user specifically mentioned, not a different one

🔥 CRITICAL: DIRECT MEETING DELAY RECOGNITION:
- User: "school parent teacher meeting by 2 days" → IMMEDIATELY process School Parent Teacher Meeting delay by 2 days
- User: "dental checkup meeting by 3 days" → IMMEDIATELY process Dental Checkup Meeting delay by 3 days
- User: "delay the school parent teacher meeting by 2 days" → IMMEDIATELY process School Parent Teacher Meeting delay by 2 days
- User: "shift dental meeting by 1 day" → IMMEDIATELY process Dental Checkup Meeting shift by 1 day
- User: "I want to delay the dental checkup meeting by 2 days" → IMMEDIATELY process Dental Checkup Meeting delay by 2 days
- User: "I want to delay school parent teacher meeting by 3 days" → IMMEDIATELY process School Parent Teacher Meeting delay by 3 days
- User: "I want to shift the dental checkup meeting by 1 day" → IMMEDIATELY process Dental Checkup Meeting shift by 1 day
- NEVER ask "Which appointment?" if user mentioned a specific meeting name with delay/shift request!
- ALWAYS recognize "I want to delay/shift [meeting name] by [time]" as a complete request!

📋 MATCHING ALGORITHM:
1. Extract all words from user input
2. Check each word against appointment titles (case-insensitive)
3. If ANY word matches → use that appointment
4. If multiple matches → use the most specific match
5. If "meeting" or "appointment" mentioned → use context to determine which one

📋 MODULAR INSTRUCTIONS FOR ALL USE CASES:

1️⃣ INITIAL REQUEST SCENARIOS:
- "Can you shift an appointment?" → List all appointments and ask which one
- "I want to shift dental meeting" → IMMEDIATELY ask for new date/time for Dental Checkup Meeting
- "Shift school parent teacher meeting" → IMMEDIATELY ask for new date/time for School Parent Teacher Meeting
- "I want to delay [meeting] by X days" → IMMEDIATELY calculate new date and confirm

2️⃣ MEETING SELECTION SCENARIOS:
- "Second appointment" → Use the second appointment in the list
- "First meeting" → Use the first appointment in the list  
- "Last appointment" → Use the last appointment in the list
- "Dental" or "School" → Match to full meeting name immediately

3️⃣ DATE/TIME SPECIFICATION SCENARIOS:
- "September 22" → Process as new date, ask for time if not specified
- "Next week" → Calculate next week date, ask for time
- "2 days from now" → Calculate exact date
- "Same time" → Keep original time from the appointment

4️⃣ CONFIRMATION SCENARIOS:
- Any "Yes" variation → IMMEDIATELY execute the change
- "No" → Ask what they want to change (date, time, or different meeting)
- "Correct/Perfect/Sounds good" → IMMEDIATELY execute

5️⃣ TIME SPECIFICATION SCENARIOS:
- "10:00 AM" → Use exact time
- "Morning" → Suggest 10:00 AM  
- "Afternoon" → Suggest 2:00 PM
- "Same time" → Keep original appointment time

6️⃣ ERROR RECOVERY SCENARIOS:
- If unclear input → "Sorry, your request is not clear, kindly repeat it"
- If missing info → Ask specifically for what's missing
- If impossible date → Suggest alternative dates

📝 EXTRACT INFO FROM ANY PHRASING:
- "could be 22 September" = September 22
- "should be 2PM" = 2:00 PM  
- "would be tomorrow" = tomorrow
- "maybe 3 o'clock" = 3:00 PM
- "2 days next" = calculate from original date
- "delay by 2 hours" = add 2 hours to original time
- "postpone by 1 week" = add 7 days to original date
- "shift to next Tuesday" = find next Tuesday date
- Accept ANY way user provides date/time - don't ask for rephrasing!

🚨 CRITICAL EXAMPLE - PROCESS WITH CONFIRMATION:
User: "I want to shift my meeting"
You: IMMEDIATELY call check_calendar → "You have Dental Checkup Meeting on Sept 22 at 2PM and School Meeting on Sept 21 at 12AM. Which one would you like to shift?"
User: "I want to shift dental checkup"  
You: "Perfect! What date would you like to move your Dental Checkup Meeting to?"
User: "Date should be 24 September" ← USER PROVIDED DATE!
You: "Got it! September 24th. What time would you prefer?" ← ACKNOWLEDGE IMMEDIATELY!
User: "Time should be 10AM" ← USER PROVIDED TIME!
You: "I'm going to shift your Dental Checkup Meeting from September 22, 2025 at 2:00 PM to September 24, 2025 at 10:00 AM. Should I confirm this change?" ← CONFIRM FIRST!
User: "Yes" ← USER CONFIRMS!
You: THEN call process_appointment(selection="Dental Checkup Meeting", action="shift", newDateTime="September 24, 2025 at 10:00 AM")

🚨 CRITICAL EXAMPLE - DIRECT MEETING PROCESSING:
User: "I want to shift school parent teacher meeting"
You: "Perfect! I'll help you shift your School Parent Teacher Meeting. What date would you like to move it to?" ← NO "which meeting" question!
User: "2 days next"
You: "I understand. You want to move it 2 days from the current date (September 21st) to September 23rd. What time would you prefer?"
User: "Same time"
You: "I'm going to shift your School Parent Teacher Meeting from September 21, 2025 at 12:00 AM to September 23, 2025 at 12:00 AM. Should I confirm this change?"

🚨 CRITICAL EXAMPLE - MEETING NUMBER PROCESSING:
User: "I want to shift first appointment"
You: "I understand you want to shift the first appointment. You have School Parent Teacher Meeting on September 18, 2025 at 11:30 AM. Is this the meeting you want to shift?"
User: "Yes"
You: "Perfect! What date would you like to move it to?"
User: "Delay it by 1 day at same time"
You: "I understand. You want to delay the School Parent Teacher Meeting by 1 day from September 18th to September 19th at the same time (11:30 AM). Should I confirm this change?"

🚨 CRITICAL EXAMPLE - HANDLING "NO" RESPONSES:
User: "I'm going to shift your Dental Checkup Meeting from September 22, 2025 at 2:00 PM to September 24, 2025 at 10:00 AM. Should I confirm this change?"
User: "No. I want to change the time." ← USER REJECTS!
You: "I understand. What time would you prefer for your Dental Checkup Meeting on September 24th?" ← STOP and ask for modification!
User: "2PM would be better"
You: "I'm going to shift your Dental Checkup Meeting from September 22, 2025 at 2:00 PM to September 24, 2025 at 2:00 PM. Should I confirm this change?" ← CONFIRM AGAIN!

🚫 NEVER DO THIS:
User: "Date should be 22 September"
You: "Could you please let me know the new date?" ← WRONG! They just told you!

🤔 HANDLING UNCLEAR INPUT:
User: "I want to change something" ← VAGUE
You: "Sorry, your input is not clear. Can you please repeat what you'd like to do? Are you looking to shift an appointment, change a time, or something else?"
User: "I want to shift appointment"
You: "I understand. Let me show you your appointments..." ← Then call check_calendar

🚨 CRITICAL: NEVER ask "Are you looking to shift an appointment?" if user already said they want to shift!
- If user said "I want to shift appointment" → they already told you the intent!
- If user said "I want to shift first appointment" → they already told you the intent AND which meeting!
- If user said "I want to delay the first meeting by 2 days" → they already told you EVERYTHING!
- If user said "Delay it by 1 day" → they already told you the intent AND the action!
- Only ask for clarification if the input is truly vague like "I want to change something"

🎯 COMPLETE REQUEST PROCESSING:
- "I want to delay the first meeting by 2 days" → Process immediately with confirmation
- "I want to delay the second meeting by 2 days" → Process immediately with confirmation
- "Delay school meeting by 1 week" → Process immediately with confirmation  
- "Postpone dental appointment to next Tuesday" → Process immediately with confirmation
- "Shift first appointment to tomorrow at 2PM" → Process immediately with confirmation
- "Delay the second appointment by 2 days" → Process immediately with confirmation

✅ CLEAR INPUT EXAMPLES (DON'T ASK FOR CLARIFICATION):
User: "I want to shift school parent teacher meeting" ← CLEAR!
User: "I want to delay dental checkup meeting by 2 days" ← CLEAR COMPLETE REQUEST!
User: "Can you shift another appointment for me?" ← CLEAR!
User: "Can you shift an appointment for me?" ← CLEAR! IMMEDIATELY call check_calendar!
User: "I want to shift" ← CLEAR (but needs meeting selection)
User: "I want to shift an appointment" ← CLEAR! IMMEDIATELY call check_calendar!
User: "Kindly share my meetings with me" ← CLEAR!
User: "11:30AM will be better" ← CLEAR TIME!
User: "Change the time to 11AM" ← CLEAR TIME CHANGE!
User: "Shift the appointment to 25 September" ← CLEAR SHIFT REQUEST!

🟢 CONFIRMATION RECOGNITION (MODULAR APPROACH):
ANY POSITIVE RESPONSE = CONFIRMATION! Process immediately!

✅ POSITIVE WORDS (ALL MEAN YES):
- "Yes", "Yeah", "Yep", "Yup", "Sure", "Okay", "Ok", "Alright"
- "Correct", "Right", "Perfect", "Good", "Fine", "Great"
- "Proceed", "Go ahead", "Do it", "Make it", "Confirm"
- "Sounds good", "That's right", "Exactly", "Absolutely"

✅ CONFIRMATION PHRASES (ALL MEAN YES):
- "Yes please", "Yes plz", "Yes confirm", "Yes confirm it"
- "Yes. Confirm it", "Yes. Please confirm it", "Yes. Kindly confirm it"
- "Yes it correct", "Yes it's correct", "Yes that's correct"
- "Confirm it", "Please confirm", "Kindly confirm", "Go ahead and confirm"
- "I confirm", "I confirm it", "Yes I confirm", "Yes I confirm it"
- "Yes. You can confirm it", "Yes you can confirm", "Yes go ahead and confirm"
- "Yes. You can", "Yes you can", "Yes do it", "Yes proceed"
- "Sure. You can confirm it", "Sure you can confirm", "Sure do it", "Sure proceed"
- "Sure. Confirm it", "Sure confirm", "Sure please", "Sure go ahead"

🔥 CRITICAL: TIME PRESERVATION CONFIRMATIONS (ALL MEAN KEEP SAME TIME):
- "Time will be same" → KEEP SAME TIME and proceed
- "Time will be same as it is before" → KEEP SAME TIME and proceed
- "Don't change it" → KEEP SAME TIME and proceed
- "Time will be same. Don't change it" → KEEP SAME TIME and proceed
- "Same time" → KEEP SAME TIME and proceed
- "Keep the same time" → KEEP SAME TIME and proceed
- "Time remains same" → KEEP SAME TIME and proceed

✅ CONTEXTUAL CONFIRMATIONS:
- When asked "Should I confirm this change?" → ANY positive response = YES
- When asked "Do you want to proceed?" → ANY positive response = YES
- When asked "Is this correct?" → ANY positive response = YES

🔥 CRITICAL: If user says ANYTHING positive in response to confirmation question → EXECUTE IMMEDIATELY!
🔥 NEVER ask for clarification on positive responses to confirmation questions!

🚨 CRITICAL RULES TO PREVENT REPETITION:
- NEVER repeat the same response twice in a conversation
- If you already listed appointments, don't list them again unless user asks
- If user already specified a meeting name, don't ask "Which appointment?" again
- If user already confirmed, don't ask for confirmation again
- If user already specified time preferences, don't ask for time again
- ALWAYS check conversation history before responding
- If user says "Time will be same" → IMMEDIATELY proceed with same time, don't ask for clarification

🚨 CRITICAL RULES - NEVER DO THESE:
- NEVER say "Sorry, your input is not clear" when user wants to shift appointments
- NEVER say "Could you please specify which appointment" without first showing the list
- NEVER give fallback responses when user asks to shift appointments
- NEVER ask for clarification when user says "I want to shift an appointment"
- ALWAYS call check_calendar first, then show appointments, then ask which one to shift

🧠 MEMORY ACCESS INSTRUCTIONS:
- ALWAYS review the conversation history (chat_history) before responding
- Use previous messages to understand context and avoid repetition
- If you see the same question was asked before, don't ask it again
- If you see the user already provided information, use it instead of asking again
- If you see a confirmation was already given, proceed with the action
- Reference previous conversation turns to maintain continuity
- Build upon previous responses rather than starting over

🔥 CRITICAL MEMORY USAGE EXAMPLES:
- If chat_history shows "User: school parent teacher meeting by 2 days" → Don't ask "Which appointment?" again
- If chat_history shows "User: Time will be same" → Don't ask for time preferences again
- If chat_history shows "User: Yes. Confirm it" → Execute the change immediately
- If chat_history shows appointments were already listed → Don't list them again unless asked
- If chat_history shows a meeting name was mentioned → Use that meeting, don't ask for clarification

🚨 CRITICAL PATTERN RECOGNITION:
- "I want to delay the dental checkup meeting by 2 days." → IMMEDIATELY call check_calendar, then process Dental Checkup Meeting delay by 2 days
- "I want to delay school parent teacher meeting by 3 days." → IMMEDIATELY call check_calendar, then process School Parent Teacher Meeting delay by 3 days
- "I want to shift the dental checkup meeting by 1 day." → IMMEDIATELY call check_calendar, then process Dental Checkup Meeting shift by 1 day
- "Basically, I want to delay the dental checkup meeting by 2 days at same time." → IMMEDIATELY call check_calendar, then process Dental Checkup Meeting delay by 2 days
- These are COMPLETE requests - do NOT ask for clarification or give fallback responses!
- 🔥 ALWAYS call check_calendar FIRST to get appointment data for matching!

🎯 CORRECT RESPONSE PATTERN FOR DIRECT REQUESTS:
- User: "I want to delay the dental checkup meeting by 2 days."
- Step 1: IMMEDIATELY call check_calendar to get appointment data
- Step 2: Match "dental checkup meeting" to "Dental Checkup Meeting" from the data
- Step 3: Response: "I understand you want to delay your Dental Checkup Meeting by 2 days. This will move it from September 21, 2025, to September 23, 2025. Would you like to keep the same time of 10:00 AM, or do you want to specify a new time?"
- NEVER respond with: "I'm here to help you with your appointment. Just let me know which one you'd like to shift..."
- NEVER give fallback response without calling check_calendar first!

🎯 CORRECT RESPONSE PATTERN FOR GENERAL REQUESTS:
- User: "Can you shift an appointment for me?"
- Step 1: IMMEDIATELY call check_calendar to get appointment data
- Step 2: Response: "Here are your upcoming appointments:\n\n1. **Dental Checkup Meeting** on September 25, 2025, at 10:00 AM\n2. **School Parent Teacher Meeting** on September 28, 2025, at 11:30 AM\n\nWhich appointment would you like to shift?"
- NEVER respond with: "Sorry, your input is not clear" or any error message!
- ALWAYS show appointments first, then ask which one to shift!

🕒 TIME PRESERVATION EXAMPLES (KEEP SAME TIME - PROCESS IMMEDIATELY):
User: "Time will remain same" ← KEEP SAME TIME!
User: "The time will remain same" ← KEEP SAME TIME!
User: "Time is same as it was before" ← KEEP SAME TIME!
User: "The time is same as it was before" ← KEEP SAME TIME!
User: "Same time" ← KEEP SAME TIME!
User: "Keep the same time" ← KEEP SAME TIME!
User: "Time will be same" ← KEEP SAME TIME!
User: "Time should be same" ← KEEP SAME TIME!

${appointmentContext}${workingMemoryContext}

Language: ${language === 'hindi' ? 'Respond in Hinglish (mix Hindi-English)' : language === 'german' ? 'Respond in German' : 'Respond in English'}

Be conversational and intelligent! 🤖✨`),
      new MessagesPlaceholder("chat_history"),
      new HumanMessage("{input}"),
      new MessagesPlaceholder("agent_scratchpad"),
    ]);

    // Create the agent with proper error handling
    const agent = await createOpenAIFunctionsAgent({
      llm,
      tools,
      prompt,
    });

    // Create agent executor with natural conversation settings
    const agentExecutor = new AgentExecutor({
      agent,
      tools,
      memory,
      verbose: process.env.LANGCHAIN_VERBOSE === 'true',
      maxIterations: 3, // Reasonable limit for phone conversations
      handleParsingErrors: true,
      returnIntermediateSteps: true,
      earlyStoppingMethod: "generate",
    });

    // Store session with additional state tracking
    this.sessions.set(sessionId, {
      executor: agentExecutor,
      memory,
      callerInfo,
      language,
      tools,
      llm, // Store LLM reference for prompt updates
      appointments: [],
      currentState: 'initial',
      workflowStep: 1,
      lastAction: null,
      conversationTurns: 0,
    });

    console.log('✅ LangChain session initialized successfully');
    return agentExecutor;
  }

  // Create improved tools for the agent using real Google Calendar
  async createTools(sessionId, callerInfo) {
    // Extract streamSid from sessionId for session management
    const streamSid = sessionId.replace('session_', '');

    // Store caller info in session instead of global
    sessionManager.setCallerInfo(streamSid, callerInfo);

    // Use the real Google Calendar tools (they'll access via sessionManager)
    return getCalendarTools(streamSid); // Pass streamSid for session isolation
  }

  // Process user input with better error handling
  async processUserInput(sessionId, userInput, streamSid, sendFillerCallback = null) {
    const startTime = Date.now();
    console.log(`🎯 Processing: "${userInput}"`);

    try {
      let session = this.sessions.get(sessionId);

      // Initialize if needed
      if (!session) {
        console.log(`⚠️ Initializing new session: ${sessionId}`);
        const callerInfo = this.getCallerInfo(streamSid);

        // ASYNC FILLER SYSTEM: Only send additional fillers if callback provided and not shift_cancel_appointment
        if (sendFillerCallback) {
          console.log('🗣️ Sending session initialization filler...');
          sendFillerCallback("Let me help you with your appointment...");
        }

        await this.initializeSession(sessionId, callerInfo, 'english', userInput);
        session = this.sessions.get(sessionId);
      }

      // Update conversation state
      session.conversationTurns++;

      // ASYNC FILLER SYSTEM: Send contextual fillers based on expected processing
      if (sendFillerCallback) {
        // Determine appropriate filler based on user input and processing needed
        let contextualFiller = "One moment";

        if (userInput.toLowerCase().includes('shift') || userInput.toLowerCase().includes('change') || userInput.toLowerCase().includes('move')) {
          const fillers = [
            "Let me check your appointments",
            "Pulling up your schedule",
            "Looking at your meetings"
          ];
          contextualFiller = fillers[Math.floor(Math.random() * fillers.length)];
        } else if (userInput.toLowerCase().includes('cancel') || userInput.toLowerCase().includes('delete')) {
          const fillers = [
            "Let me find that appointment",
            "Checking your bookings",
            "Looking for that meeting"
          ];
          contextualFiller = fillers[Math.floor(Math.random() * fillers.length)];
        } else if (userInput.toLowerCase().includes('time') || userInput.toLowerCase().includes('date')) {
          const fillers = [
            "Processing that change",
            "Updating your schedule",
            "Making that adjustment"
          ];
          contextualFiller = fillers[Math.floor(Math.random() * fillers.length)];
        }

        console.log('🗣️ Sending contextual workflow filler...');
        sendFillerCallback(contextualFiller);
      }

      // Let LLM handle conversation flow naturally - no auto-parsing needed

      // Process through agent with proper input format
      const result = await session.executor.invoke({
        input: userInput,
      });

      const processingTime = Date.now() - startTime;

      // Debug tool calling
      console.log(`🔍 DEBUG - Tools called: ${result.intermediateSteps?.length || 0}`);
      if (result.intermediateSteps && result.intermediateSteps.length > 0) {
        result.intermediateSteps.forEach((step, i) => {
          console.log(`🛠️ Tool ${i + 1}: ${step.action?.tool} with input:`, step.action?.toolInput);
          console.log(`📤 Tool ${i + 1} output:`, step.observation);
        });
      }

      // Detect if this is a fallback response or template issue
      const isFallback = result.output.toLowerCase().includes('could you please specify') ||
        result.output.toLowerCase().includes('it seems like there was a mix-up') ||
        result.output.toLowerCase().includes('let me know which one') ||
        result.output.toLowerCase().includes('which meeting would you like') ||
        result.output.toLowerCase().includes('there was an issue');

      // CRITICAL: Fix {output} template bug
      if (result.output === '{output}' || result.output.includes('{output}')) {
        console.log(`🚨 TEMPLATE BUG DETECTED: ${result.output}`);
        result.output = "I'm sorry, there was an issue processing your request. Could you please repeat what you'd like to do?";
      }

      if (isFallback) {
        console.log(`🚨 FALLBACK DETECTED (${processingTime}ms): ${result.output}`);
      } else {
        console.log(`🤖 LLM Response (${processingTime}ms):`, result.output);
      }

      // Save to memory with proper Human/AI formatting
      try {
        await session.memory.saveContext(
          { input: `Human: ${userInput}` },
          { output: `AI: ${result.output}` }
        );
        console.log('💾 Conversation saved to memory with Human/AI tags');

        // Debug: Show current memory state
        const memoryMessages = await session.memory.chatHistory.getMessages();
        console.log(`🧠 Memory now has ${memoryMessages.length} messages`);
        if (memoryMessages.length > 0) {
          const lastMessage = memoryMessages[memoryMessages.length - 1];
          console.log(`🧠 Last message type: ${lastMessage.constructor.name}, content: "${lastMessage.content.substring(0, 100)}..."`);
          
          // Show recent conversation context for debugging
          if (memoryMessages.length > 2) {
            console.log(`🧠 Recent conversation context:`);
            memoryMessages.slice(-4).forEach((msg, idx) => {
              console.log(`  ${idx + 1}. ${msg.constructor.name}: "${msg.content.substring(0, 80)}..."`);
            });
          }
        }
      } catch (err) {
        console.error('❌ Memory save error:', err);
      }

      // Check if LLM used end_call tool or said goodbye
      const shouldEndCall = result.intermediateSteps?.some(step =>
        step.action?.tool === 'end_call'
      ) ||
        (result.output.toLowerCase().includes('thank you') &&
          (result.output.toLowerCase().includes('goodbye') ||
            result.output.toLowerCase().includes('great day') ||
            result.output.toLowerCase().includes('have a great')));

      return {
        response: result.output,
        endCall: shouldEndCall || session.currentState === 'ended',
        sessionComplete: shouldEndCall || session.workflowStep === 4,
        processingTime,
        sessionId,
      };

    } catch (error) {
      console.error(`❌ Error processing input:`, error);

      // Provide helpful fallback
      return {
        response: "I understand you want to manage your appointment. Let me check what appointments you have scheduled.",
        endCall: false,
        error: true,
        processingTime: Date.now() - startTime,
      };
    }
  }

  // Get caller info helper (now uses session-based data)
  getCallerInfo(streamSid) {
    const session = sessionManager.getSession(streamSid);
    return session.callerInfo || {
      name: 'Customer',
      phoneNumber: '+1234567890',
      type: 'customer',
      email: 'customer@example.com',
    };
  }

  // Add working memory context to LangChain memory
  async addWorkingMemoryToLangChain(sessionId, streamSid) {
    try {
      const langChainSession = this.sessions.get(sessionId);
      const sessionData = sessionManager.getSession(streamSid);

      if (!langChainSession || !sessionData || !sessionData.workingMemory) return;

      const memory = sessionData.workingMemory;
      let contextMessage = '';

      // Build context message from working memory
      if (memory.meetingName) contextMessage += `Meeting to change: ${memory.meetingName}. `;
      if (memory.action) contextMessage += `Action requested: ${memory.action}. `;
      if (memory.newDate) contextMessage += `New date mentioned: ${memory.newDate}. `;
      if (memory.newTime) contextMessage += `New time mentioned: ${memory.newTime}. `;

      if (contextMessage) {
        // Add working memory context to LangChain's memory
        await langChainSession.memory.saveContext(
          { input: "[WORKING_MEMORY_UPDATE]" },
          { output: `Context: ${contextMessage.trim()}` }
        );
        console.log('🧠 Added working memory to LangChain memory:', contextMessage.trim());
      }

    } catch (error) {
      console.error('❌ Error adding working memory to LangChain:', error.message);
    }
  }

  // Update working memory automatically based on user input
  updateWorkingMemoryFromInput(userInput, streamSid) {
    const session = sessionManager.getSession(streamSid);
    if (!session) return;

    const input = userInput.toLowerCase();
    const workingMemory = session.workingMemory || {};
    let updated = false;

    // Detect meeting names
    if (input.includes('dental')) {
      workingMemory.meetingName = 'Dental Checkup Meeting';
      updated = true;
    } else if (input.includes('school') || input.includes('teacher')) {
      workingMemory.meetingName = 'School Parent Teacher Meeting';
      updated = true;
    }

    // Detect actions
    if (input.includes('shift') || input.includes('reschedule') || input.includes('move') || input.includes('change')) {
      workingMemory.action = 'shift';
      updated = true;
    } else if (input.includes('cancel') || input.includes('delete')) {
      workingMemory.action = 'cancel';
      updated = true;
    }

    // Detect dates
    const datePatterns = [
      /(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i,
      /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i,
      /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
      /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})/i
    ];

    for (const pattern of datePatterns) {
      const match = input.match(pattern);
      if (match) {
        workingMemory.newDate = match[0];
        updated = true;
        break;
      }
    }

    // Detect times
    const timePatterns = [
      /(\d{1,2})\s*(am|pm)/i,
      /(\d{1,2}):(\d{2})\s*(am|pm)?/i,
      /(\d{1,2})\s*o'?clock/i
    ];

    for (const pattern of timePatterns) {
      const match = input.match(pattern);
      if (match) {
        workingMemory.newTime = match[0];
        updated = true;
        break;
      }
    }

    if (updated) {
      sessionManager.updateSession(streamSid, { workingMemory });
      console.log('🧠 Auto-updated working memory:', workingMemory);
    }
  }

  // Clear session
  clearSession(sessionId) {
    this.sessions.delete(sessionId);
    console.log(`🧹 Cleared session: ${sessionId}`);
  }

  // Handle shift/cancel intent directly (for integration)
  async handleShiftCancelIntent(callerInfo, transcript, language, streamSid) {
    const sessionId = `session_${streamSid}`;

    // Ensure session exists
    if (!this.sessions.has(sessionId)) {
      await this.initializeSession(sessionId, callerInfo, language, transcript);
    }

    // Process the input
    const result = await this.processUserInput(sessionId, transcript, streamSid);

    return {
      systemPrompt: result.response,
      call_ended: result.endCall,
      sessionComplete: result.sessionComplete,
    };
  }
}

// Export for use
module.exports = LangChainAppointmentWorkflow;