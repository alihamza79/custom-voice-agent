# Customer Workflow & SMS Integration Analysis

## 🔄 Complete Customer Workflow Flow

### 1. **Call Initiation**
```
Customer calls → greetingNode → customerIntentNode
```

### 2. **Intent Classification** (`customerIntentNode.js`)
- **Input**: Customer transcript (e.g., "I want to reschedule my appointment")
- **Process**: OpenAI GPT-4o-mini classifies intent as `shift_cancel_appointment`
- **Action**: Routes to LangGraph workflow

### 3. **LangGraph Workflow** (`src/workflows/langgraph/`)
- **Node 1**: `generateResponse` - LLM processes user request
- **Node 2**: `executeTools` - Calls `get_appointments` tool
- **Node 3**: `generateResponse` - Shows appointments, asks for new time
- **Node 4**: `executeTools` - Calls `shift_appointment` tool
- **Node 5**: `generateResponse` - Confirms change, offers assistance

### 4. **Appointment Change Execution** (`calendarTools.js`)
```javascript
// shift_appointment tool execution
const shiftAppointmentTool = {
  name: "shift_appointment",
  func: async ({ appointmentName, newDateTime, confirmationReceived }) => {
    // 1. Verify user confirmation
    // 2. Find appointment in calendar
    // 3. Update Google Calendar
    // 4. Return success message
    return `Successfully shifted "${appointmentName}" to ${newDateTime}`;
  }
}
```

### 5. **Call Termination & SMS Triggering**

#### **Path A: Graceful Termination** (`customerIntentNode.js`)
```javascript
if (shouldEndCall) {
  setTimeout(async () => {
    // 1. End call gracefully
    await callTerminationService.endCall(callSid, streamSid);
    
    // 2. Send SMS confirmation (1 second delay)
    setTimeout(async () => {
      await callTerminationService.sendConfirmationSMS(
        streamSid, 
        'confirmed', 
        callDuration
      );
    }, 1000);
  }, 2000); // 2 second delay for graceful ending
}
```

#### **Path B: Connection Close** (`sessionManager.js`)
```javascript
cleanupSession(streamSid, reason = 'connection_closed') {
  if (reason === 'connection_closed' && session.callerInfo) {
    this.triggerSMSCleanup(streamSid, session);
  }
}

async triggerSMSCleanup(streamSid, session) {
  // Check if appointment was successfully changed
  if (sessionData.response.includes('successfully shifted')) {
    // Send SMS asynchronously
    setTimeout(async () => {
      await callTerminationService.sendConfirmationSMS(
        streamSid, outcome, callDuration
      );
    }, 1000);
  }
}
```

## 📱 SMS Integration Points

### **1. SMS Service** (`smsService.js`)
```javascript
class SMSService {
  async sendAppointmentConfirmation(appointmentDetails, callOutcome, callDuration) {
    const message = this.generateConfirmationMessage(appointmentDetails, callOutcome, callDuration);
    return await this.sendSMS(this.teammatePhoneNumber, message);
  }
}
```

### **2. Call Outcome Tracker** (`callOutcomeTracker.js`)
```javascript
class CallOutcomeTracker {
  trackOutcome(streamSid, outcome, appointmentDetails, callDuration) {
    this.outcomes.set(streamSid, { outcome, appointmentDetails, callDuration });
  }
  
  async sendConfirmationSMS(streamSid, outcome) {
    const result = await smsService.sendAppointmentConfirmation(
      appointmentDetails, outcome, callDuration
    );
  }
}
```

### **3. Call Termination Service** (`callTerminationService.js`)
```javascript
class CallTerminationService {
  async sendConfirmationSMS(streamSid, callOutcome, callDuration) {
    // Track the outcome
    callOutcomeTracker.trackOutcome(streamSid, callOutcome, appointmentDetails, callDuration);
    
    // Send confirmation SMS
    return await callOutcomeTracker.sendConfirmationSMS(streamSid, callOutcome);
  }
}
```

## 🔄 Complete SMS Flow

### **Step 1: Appointment Change Detected**
- LangGraph `shift_appointment` tool executes successfully
- Returns: `"Successfully shifted 'Head checkup' to September 30, 2025 at 02:00 PM"`

### **Step 2: Call End Detection**
- **Graceful**: `shouldEndCall = true` → triggers SMS in `customerIntentNode.js`
- **Unexpected**: `connection_closed` → triggers SMS in `sessionManager.js`

### **Step 3: SMS Generation**
```javascript
// Message template based on outcome
const message = `✅ Appointment Rescheduled

Customer: ${customerName}
Appointment: ${appointmentName}
Old Time: ${oldTime}
New Time: ${newTime}
Status: Rescheduled by customer
Call Duration: ${callDuration}`;
```

### **Step 4: SMS Delivery**
- **From**: `+4915888648880` (your SMS number)
- **To**: `+491726073488` (teammate number)
- **Service**: Twilio SMS API
- **Timing**: 1 second after call termination

## 🎯 Key Integration Points

### **1. Dual SMS Triggers**
- **Primary**: Graceful call termination in `customerIntentNode.js`
- **Backup**: Connection close detection in `sessionManager.js`

### **2. Asynchronous Processing**
- SMS sent with 1-second delay to avoid blocking call cleanup
- Non-blocking error handling

### **3. Smart Outcome Detection**
- Detects appointment changes by response content
- Maps to appropriate SMS templates (rescheduled, cancelled, confirmed)

### **4. Robust Error Handling**
- SMS failures don't crash the system
- Graceful fallbacks for missing data

## 📊 SMS Message Examples

### **Rescheduled Appointment**
```
✅ Appointment Rescheduled

Customer: Arman
Appointment: Head checkup
Old Time: Monday, September 8, 2025 at 07:00 PM
New Time: Tuesday, September 9, 2025 at 08:00 PM
Status: Rescheduled by customer
Call Duration: 3m 15s
```

### **Cancelled Appointment**
```
❌ Appointment Cancelled

Customer: Arman
Appointment: Head checkup
Time: Monday, September 8, 2025 at 07:00 PM
Status: Cancelled by customer
Call Duration: 1m 45s
```

## ✅ Integration Status

- **SMS Service**: ✅ Working (tested with +491726073488)
- **Dual Triggers**: ✅ Implemented (graceful + connection close)
- **Asynchronous**: ✅ Non-blocking with delays
- **Error Handling**: ✅ Robust fallbacks
- **Message Templates**: ✅ Dynamic based on outcome
- **Environment Config**: ✅ Uses +491726073488 as default

The SMS integration is fully functional and will send notifications to +491726073488 whenever customers make appointment changes!
