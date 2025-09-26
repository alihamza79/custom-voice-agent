# SMS Service Usage Analysis

## 📁 **SMS Service File Structure**

### **Core SMS Files:**
- `src/services/smsService.js` - Main SMS service using Twilio API
- `src/services/callOutcomeTracker.js` - Tracks call outcomes for SMS
- `src/services/callTerminationService.js` - Orchestrates SMS sending

## 🔗 **SMS Service Dependencies**

### **1. smsService.js**
```javascript
// Dependencies:
- twilio (Twilio SMS API)
- dotenv (Environment variables)
- Environment variables: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SMS_PHONE_NUMBER, TEAMMATE_PHONE_NUMBER
```

### **2. callOutcomeTracker.js**
```javascript
// Dependencies:
- smsService.js (Main SMS functionality)
- sessionManager.js (Session data extraction)
- Environment variables: TEAMMATE_PHONE_NUMBER, SMS_PHONE_NUMBER, TWILIO_SMS_ENABLED
```

### **3. callTerminationService.js**
```javascript
// Dependencies:
- callOutcomeTracker.js (SMS orchestration)
- twilio (Call termination)
```

## 📱 **SMS Service Usage by Component**

### **1. Customer Intent Node** (`src/graph/nodes/customerIntentNode.js`)
**Usage**: Sends SMS after customer appointment changes
```javascript
// Lines 140, 571
await callTerminationService.sendConfirmationSMS(
  state.streamSid, 
  'confirmed', 
  callDuration
);
```

### **2. Outbound Customer Verify Intent Node** (`src/graph/nodes/outboundCustomerVerifyIntentNode.js`)
**Usage**: Sends SMS after customer verification calls
```javascript
// Line 723
await callTerminationService.sendConfirmationSMS(
  state.streamSid, 
  smsOutcome, 
  callDuration
);
```

### **3. Session Manager** (`src/services/sessionManager.js`)
**Usage**: Backup SMS trigger for unexpected connection closes
```javascript
// Line 293
await callTerminationService.sendConfirmationSMS(
  streamSid, outcome, callDuration
);
```

## 🎯 **SMS Triggering Scenarios**

### **Scenario 1: Customer Appointment Changes**
- **Trigger**: Customer modifies appointment via LangGraph workflow
- **Node**: `customerIntentNode.js`
- **SMS Types**: `confirmed`, `rescheduled`, `cancelled`
- **Recipient**: `+491726073488` (teammate)

### **Scenario 2: Outbound Customer Verification**
- **Trigger**: Customer responds to outbound verification call
- **Node**: `outboundCustomerVerifyIntentNode.js`
- **SMS Types**: `appointment_confirmed`, `appointment_rescheduled`, `appointment_declined`
- **Recipient**: `+491726073488` (teammate)

### **Scenario 3: Connection Close Backup**
- **Trigger**: Unexpected connection termination
- **Service**: `sessionManager.js`
- **SMS Types**: All types based on response content
- **Recipient**: `+491726073488` (teammate)

## 📊 **SMS Message Templates**

### **Customer Appointment Changes:**
- `confirmed`: "✅ Appointment Confirmed"
- `rescheduled`: "🔄 Appointment Rescheduled" 
- `cancelled`: "❌ Appointment Cancelled"

### **Customer Verification:**
- `appointment_confirmed`: "✅ Customer Confirmed Appointment"
- `appointment_rescheduled`: "🔄 Customer Wants to Reschedule"
- `appointment_declined`: "❌ Customer Declined Appointment"

### **General:**
- `customer_verification_completed`: "📞 Customer Verification Completed"

## 🔧 **Environment Configuration**

### **Required Variables:**
```env
# Twilio Configuration
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token

# SMS Configuration
SMS_PHONE_NUMBER=+4915888648880
TEAMMATE_PHONE_NUMBER=+491726073488
TWILIO_SMS_ENABLED=true
```

## 📈 **SMS Service Flow**

### **1. SMS Triggering**
```
User Action → Intent Classification → Workflow Execution → Call Termination → SMS Trigger
```

### **2. SMS Processing**
```
callTerminationService.sendConfirmationSMS() 
→ callOutcomeTracker.trackOutcome() 
→ smsService.sendAppointmentConfirmation() 
→ Twilio SMS API 
→ +491726073488
```

### **3. Error Handling**
- SMS failures don't crash the system
- Graceful fallbacks for missing data
- Asynchronous processing with delays

## ✅ **Integration Status**

- **SMS Service**: ✅ Working (tested with real Twilio API)
- **Customer Intent**: ✅ Integrated with appointment changes
- **Outbound Verification**: ✅ Integrated with customer responses
- **Session Cleanup**: ✅ Backup trigger for connection closes
- **Message Templates**: ✅ Customized for different scenarios
- **Error Handling**: ✅ Robust fallbacks
- **Environment Config**: ✅ Properly configured

## 🧪 **Testing Status**

- **Unit Tests**: ✅ SMS service tested individually
- **Integration Tests**: ✅ Full workflow tested
- **Real SMS**: ✅ Successfully sent to +491726073488
- **Error Scenarios**: ✅ Handled gracefully

The SMS service is fully integrated and working across all customer interaction scenarios!

