# SMS Service Organization & Usage

## 📁 **File Structure**

### **Core SMS Files (in `src/services/`):**
- ✅ `smsService.js` - Main SMS service using Twilio API
- ✅ `callOutcomeTracker.js` - Tracks call outcomes for SMS
- ✅ `callTerminationService.js` - Orchestrates SMS sending

### **Test Files (DELETED):**
- ❌ `test-sms-service.js` - Deleted
- ❌ `test-sms-to-self.js` - Deleted  
- ❌ `test-sms-integration.js` - Deleted
- ❌ `test-outbound-sms.js` - Deleted
- ❌ `fetch-sms-status.js` - Deleted

## 🔗 **SMS Service Usage**

### **1. Direct Usage:**
- `callOutcomeTracker.js` → `smsService.js` (Line 3, 63)

### **2. Indirect Usage (via callTerminationService):**
- `customerIntentNode.js` → `callTerminationService.sendConfirmationSMS()` (Lines 140, 571)
- `outboundCustomerVerifyIntentNode.js` → `callTerminationService.sendConfirmationSMS()` (Line 723)
- `sessionManager.js` → `callTerminationService.sendConfirmationSMS()` (Line 293)

## 📱 **SMS Triggering Points**

### **Customer Intent Node:**
```javascript
// Lines 140, 571
await callTerminationService.sendConfirmationSMS(
  state.streamSid, 
  'confirmed', 
  callDuration
);
```

### **Outbound Customer Verify Intent Node:**
```javascript
// Line 723
await callTerminationService.sendConfirmationSMS(
  state.streamSid, 
  smsOutcome, 
  callDuration
);
```

### **Session Manager (Backup):**
```javascript
// Line 293
await callTerminationService.sendConfirmationSMS(
  streamSid, outcome, callDuration
);
```

## 🎯 **SMS Scenarios**

### **1. Customer Appointment Changes:**
- **Trigger**: Customer modifies appointment via LangGraph
- **Node**: `customerIntentNode.js`
- **SMS Types**: `confirmed`, `rescheduled`, `cancelled`

### **2. Outbound Customer Verification:**
- **Trigger**: Customer responds to outbound call
- **Node**: `outboundCustomerVerifyIntentNode.js`
- **SMS Types**: `appointment_confirmed`, `appointment_rescheduled`, `appointment_declined`

### **3. Connection Close Backup:**
- **Trigger**: Unexpected connection termination
- **Service**: `sessionManager.js`
- **SMS Types**: All types based on response content

## 📊 **SMS Message Templates**

### **Customer Appointment Changes:**
- `confirmed`: "✅ Appointment Confirmed"
- `rescheduled`: "🔄 Appointment Rescheduled"
- `cancelled`: "❌ Appointment Cancelled"

### **Customer Verification:**
- `appointment_confirmed`: "✅ Customer Confirmed Appointment"
- `appointment_rescheduled`: "🔄 Customer Wants to Reschedule"
- `appointment_declined`: "❌ Customer Declined Appointment"

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

## ✅ **Integration Status**

- **SMS Service**: ✅ Working (tested with real Twilio API)
- **Customer Intent**: ✅ Integrated with appointment changes
- **Outbound Verification**: ✅ Integrated with customer responses
- **Session Cleanup**: ✅ Backup trigger for connection closes
- **Message Templates**: ✅ Customized for different scenarios
- **Error Handling**: ✅ Robust fallbacks
- **File Organization**: ✅ Clean structure, test files removed

## 📈 **SMS Flow**

```
User Action → Intent Classification → Workflow Execution → Call Termination → SMS Trigger
↓
callTerminationService.sendConfirmationSMS() → callOutcomeTracker.trackOutcome() → smsService.sendAppointmentConfirmation() → Twilio SMS API → +491726073488
```

The SMS service is properly organized and fully integrated across all customer interaction scenarios!
