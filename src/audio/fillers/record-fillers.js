// Script to pre-record filler audio files using Azure TTS
// This will generate audio files for all teammate intent node fillers

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from the project root
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const azureTTSService = require('../../services/azureTTSService');

// Filler texts from teammate intent node
const fillerTexts = {
  // Delay notification fillers
  delay_notification: [
    "Let me pull up your appointments and check your current schedule",
    "I'm checking your calendar and looking at your meetings right now",
    "Let me see what meetings you have and review your schedule",
    "I'm looking up your meetings and fetching your calendar information",
    "Let me access your calendar and pull up all your appointments",
    "I'm checking your schedule and reviewing your upcoming meetings",
    "Let me fetch your calendar data and see what appointments you have"
  ],
  
  // Calendar update fillers
  calendar_update: [
    "I'm updating your appointment in the calendar system right now",
    "Let me save these changes to your Google Calendar",
    "I'm processing the appointment update and confirming the changes",
    "Let me update your calendar with the new appointment time"
  ],
  
  // Calendar fetch fillers
  calendar_fetch: [
    "Let me get your updated calendar and check your appointments",
    "I'm fetching your calendar data to show you the current schedule",
    "Let me pull up your updated appointments and calendar information",
    "I'm checking your calendar to get the latest appointment details"
  ]
};

class FillerRecorder {
  constructor() {
    this.outputDir = path.join(__dirname, 'recordings');
    this.azureTTS = azureTTSService;
    
    // Create output directory
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async recordFiller(text, category, index) {
    try {
      console.log(`🎤 Recording: "${text}"`);
      
      const fileName = `${category}_${index + 1}.wav`;
      const filePath = path.join(this.outputDir, fileName);
      
      // Initialize Azure TTS if needed
      if (!this.azureTTS.isServiceReady()) {
        await this.azureTTS.initialize();
      }
      
      // Use Azure TTS to generate audio buffer
      const audioBuffer = await this.synthesizeToBuffer(text, 'english');
      
      // Save to file
      fs.writeFileSync(filePath, audioBuffer);
      
      console.log(`✅ Saved: ${fileName}`);
      
      return {
        text: text,
        fileName: fileName,
        filePath: filePath,
        category: category
      };
      
    } catch (error) {
      console.error(`❌ Error recording "${text}":`, error.message);
      return null;
    }
  }

  // Helper method to synthesize text to audio buffer
  async synthesizeToBuffer(text, language = 'english') {
    return new Promise((resolve, reject) => {
      const sdk = require("microsoft-cognitiveservices-speech-sdk");
      const { AZURE_TTS_CONFIG } = require('../../config/constants');
      const { SPEECH_KEY, SPEECH_REGION } = require('../../config/environment');
      
      if (!SPEECH_KEY || !SPEECH_REGION) {
        reject(new Error('Azure TTS credentials not configured'));
        return;
      }
      
      // Create speech configuration
      const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
      speechConfig.speechSynthesisVoiceName = AZURE_TTS_CONFIG.voiceName;
      speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat[AZURE_TTS_CONFIG.outputFormat];
      
      // Create SSML
      const ssml = this.createSSML(text, language);
      
      // Create synthesizer
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
      
      // Synthesize to buffer
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve(Buffer.from(result.audioData));
          } else {
            reject(new Error(`Synthesis failed: ${result.errorDetails}`));
          }
          synthesizer.close();
        },
        (error) => {
          reject(error);
          synthesizer.close();
        }
      );
    });
  }

  // Create SSML for synthesis
  createSSML(text, language = 'english') {
    const { AZURE_TTS_CONFIG } = require('../../config/constants');
    
    const escapedText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    return `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
        <voice name="${AZURE_TTS_CONFIG.voiceName}">
          <prosody rate="${AZURE_TTS_CONFIG.prosodyRate}" pitch="${AZURE_TTS_CONFIG.prosodyPitch}">
            ${escapedText}
          </prosody>
        </voice>
      </speak>`;
  }

  async recordAllFillers() {
    console.log('🚀 Starting filler audio recording...');
    console.log(`📁 Output directory: ${this.outputDir}`);
    
    const recordings = [];
    
    for (const [category, texts] of Object.entries(fillerTexts)) {
      console.log(`\n📂 Recording ${category} fillers...`);
      
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        const recording = await this.recordFiller(text, category, i);
        
        if (recording) {
          recordings.push(recording);
        }
        
        // Small delay between recordings
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Generate index file
    await this.generateIndexFile(recordings);
    
    console.log(`\n🎉 Recording complete! Generated ${recordings.length} audio files.`);
    return recordings;
  }

  async generateIndexFile(recordings) {
    const indexData = {
      generatedAt: new Date().toISOString(),
      totalRecordings: recordings.length,
      categories: {},
      recordings: recordings
    };
    
    // Group by category
    for (const recording of recordings) {
      if (!indexData.categories[recording.category]) {
        indexData.categories[recording.category] = [];
      }
      indexData.categories[recording.category].push({
        text: recording.text,
        fileName: recording.fileName,
        filePath: recording.filePath
      });
    }
    
    const indexPath = path.join(this.outputDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2));
    
    console.log(`📋 Generated index file: ${indexPath}`);
  }
}

// Run the recording process
async function main() {
  try {
    const recorder = new FillerRecorder();
    await recorder.recordAllFillers();
  } catch (error) {
    console.error('❌ Recording failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { FillerRecorder, fillerTexts };
