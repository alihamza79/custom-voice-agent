# 🔧 Environment Variables Setup Guide

## 📋 Required Environment Variables

### Core Voice Agent Services (REQUIRED)

```bash
# Deepgram Speech-to-Text API
DEEPGRAM_API_KEY=your_deepgram_api_key_here
# Get from: https://console.deepgram.com/

# OpenAI API (for intent classification and greeting generation)
OPENAI_API_KEY=your_openai_api_key_here  
# Get from: https://platform.openai.com/api-keys

# Azure Cognitive Services Speech (Text-to-Speech)
AZURE_SPEECH_KEY=your_azure_speech_key_here
AZURE_SPEECH_REGION=your_azure_region_here
# Get from: https://portal.azure.com/ -> Cognitive Services -> Speech

# Twilio (for phone calls and WhatsApp)
TWILIO_ACCOUNT_SID=your_twilio_account_sid_here
TWILIO_AUTH_TOKEN=your_twilio_auth_token_here
# Get from: https://console.twilio.com/
```

### Optional Services (Will use mock data if not provided)

```bash
# MongoDB Atlas (for workflow logging)
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/voiceagent?retryWrites=true&w=majority
# Get from: https://cloud.mongodb.com/

# Google Calendar API (for appointment management)
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_REFRESH_TOKEN=your_google_refresh_token_here
# Get from: https://console.developers.google.com/
```

### Configuration (Optional)

```bash
# Server Configuration
PORT=8080
NODE_ENV=development

# OpenAI Model Selection
OPENAI_MODEL=gpt-4o-mini

# Language Settings
DEFAULT_LANGUAGE=english
SUPPORTED_LANGUAGES=english,hindi,german
```

## 🚀 Quick Setup

1. **Create `.env` file** in the project root:
   ```bash
   touch .env
   ```

2. **Add required variables** (minimum for basic functionality):
   ```bash
   DEEPGRAM_API_KEY=your_key_here
   OPENAI_API_KEY=your_key_here
   AZURE_SPEECH_KEY=your_key_here
   AZURE_SPEECH_REGION=eastus
   TWILIO_ACCOUNT_SID=your_sid_here
   TWILIO_AUTH_TOKEN=your_token_here
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Start the server**:
   ```bash
   npm start
   ```

## 📱 Service Setup Instructions

### 1. Deepgram (Speech-to-Text)
- Sign up at https://console.deepgram.com/
- Create a new project
- Copy the API key from the dashboard

### 2. OpenAI (Intent Classification)
- Sign up at https://platform.openai.com/
- Go to API Keys section
- Create a new secret key

### 3. Azure Speech Services (Text-to-Speech)
- Sign up at https://portal.azure.com/
- Create a new "Speech Services" resource
- Copy the key and region from the resource

### 4. Twilio (Phone & WhatsApp)
- Sign up at https://console.twilio.com/
- Copy Account SID and Auth Token from dashboard
- For WhatsApp: Enable WhatsApp sandbox in console

### 5. MongoDB Atlas (Optional - Database)
- Sign up at https://cloud.mongodb.com/
- Create a new cluster
- Get connection string from "Connect" -> "Connect your application"

### 6. Google Calendar API (Optional - Appointments)
- Go to https://console.developers.google.com/
- Create a new project
- Enable Calendar API
- Create OAuth 2.0 credentials
- Generate refresh token using OAuth playground

## ✅ Verification

After setup, you should see:
```
✅ All required environment variables are set
🚀 Prewarming caller identification graph...
✅ Caller identification graph with intent classification compiled successfully
Server listening on: http://localhost:8080
🚀 Initializing Azure TTS with real-time streaming...
✅ Caller identification graph prewarmed successfully
📞 Phonebook loaded with 10 contacts
```

## 🔧 Troubleshooting

### Missing Environment Variables
If you see warnings about missing variables, the system will use mock services:
- MongoDB → Mock logging to console
- Google Calendar → Mock appointments data
- WhatsApp → Mock notifications to console

### TTS Not Working
- Verify `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` are correct
- Check Azure Speech Services quota/billing

### STT Not Working  
- Verify `DEEPGRAM_API_KEY` is correct
- Check Deepgram account credits/billing

### Intent Classification Not Working
- Verify `OPENAI_API_KEY` is correct  
- Check OpenAI account credits/billing

