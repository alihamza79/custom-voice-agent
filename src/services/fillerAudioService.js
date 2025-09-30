// Filler Audio Service - Uses pre-recorded audio files instead of real-time TTS
const fs = require('fs');
const path = require('path');

class FillerAudioService {
  constructor() {
    // Teammate recordings directory
    this.recordingsDir = path.join(__dirname, '../audio/fillers/recordings');
    this.indexFile = path.join(this.recordingsDir, 'index.json');
    
    // Customer fillers directory
    this.customerFillersDir = path.join(__dirname, '../audio/fillers/customer');
    this.customerIndexFile = path.join(this.customerFillersDir, 'customer-fillers-mapping.json');
    
    this.audioIndex = null;
    this.customerFillers = null;
    this.loadAudioIndex();
    this.loadCustomerFillers();
  }

  loadAudioIndex() {
    try {
      if (fs.existsSync(this.indexFile)) {
        const indexData = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        this.audioIndex = indexData;
        console.log(`📁 Loaded ${indexData.totalRecordings} pre-recorded teammate filler audio files`);
      } else {
        console.log('⚠️ No teammate audio index found. Run record-fillers.js first.');
        this.audioIndex = null;
      }
    } catch (error) {
      console.error('❌ Error loading teammate audio index:', error.message);
      this.audioIndex = null;
    }
  }

  loadCustomerFillers() {
    try {
      if (fs.existsSync(this.customerIndexFile)) {
        const customerData = JSON.parse(fs.readFileSync(this.customerIndexFile, 'utf8'));
        this.customerFillers = customerData;
        const totalFillers = Object.values(customerData).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`📁 Loaded ${totalFillers} pre-recorded customer filler audio files`);
      } else {
        console.log('⚠️ No customer audio index found.');
        this.customerFillers = null;
      }
    } catch (error) {
      console.error('❌ Error loading customer audio index:', error.message);
      this.customerFillers = null;
    }
  }

  // Get a random customer filler audio for a specific category
  getRandomCustomerFiller(category) {
    if (!this.customerFillers || !this.customerFillers[category]) {
      console.log(`⚠️ No customer audio files found for category: ${category}`);
      return null;
    }

    const categoryFiles = this.customerFillers[category];
    const randomIndex = Math.floor(Math.random() * categoryFiles.length);
    const selectedFile = categoryFiles[randomIndex];

    // Build absolute path
    const filePath = path.join(this.customerFillersDir, selectedFile.file);

    return {
      text: selectedFile.text,
      fileName: selectedFile.file,
      filePath: filePath,
      category: category
    };
  }

  // Get a random filler audio file for a specific category (teammate)
  getRandomFillerAudio(category) {
    if (!this.audioIndex || !this.audioIndex.categories[category]) {
      console.log(`⚠️ No teammate audio files found for category: ${category}`);
      return null;
    }

    const categoryFiles = this.audioIndex.categories[category];
    const randomIndex = Math.floor(Math.random() * categoryFiles.length);
    const selectedFile = categoryFiles[randomIndex];

    // Use direct path (already absolute in index.json, but fix for current system)
    const filePath = path.join(this.recordingsDir, selectedFile.fileName);

    return {
      text: selectedFile.text,
      fileName: selectedFile.fileName,
      filePath: filePath,
      category: category
    };
  }

  // Get specific filler audio by text
  getFillerAudioByText(text) {
    if (!this.audioIndex) {
      return null;
    }

    for (const recording of this.audioIndex.recordings) {
      if (recording.text === text) {
        return {
          text: recording.text,
          fileName: recording.fileName,
          filePath: recording.filePath,
          category: recording.category
        };
      }
    }

    return null;
  }

  // Play filler audio directly (0ms delay)
  async playFillerAudio(fillerText, streamSid, language = 'english', callerType = null) {
    try {
      let audioFile = null;
      
      // Determine caller type if not provided
      if (!callerType && streamSid) {
        const sessionManager = require('./sessionManager');
        const session = sessionManager.getSession(streamSid);
        callerType = session?.callerInfo?.type || 'customer';
      }
      
      // For customers, use customer fillers
      if (callerType === 'customer') {
        let category = this.detectCustomerFillerCategory(fillerText);
        if (category) {
          audioFile = this.getRandomCustomerFiller(category);
          console.log(`🎵 Using CUSTOMER filler (${category}): "${audioFile?.text}"`);
        }
      } 
      // For teammates, use teammate recordings
      else if (callerType === 'teammate') {
        // Try to find exact match first
        audioFile = this.getFillerAudioByText(fillerText);
        
        // If no exact match, try to find by category
        if (!audioFile) {
          let category = this.detectCategory(fillerText);
          if (category) {
            audioFile = this.getRandomFillerAudio(category);
          }
        }
        console.log(`🎵 Using TEAMMATE filler: "${audioFile?.text}"`);
      }

      if (audioFile && fs.existsSync(audioFile.filePath)) {
        console.log(`🎵 Playing pre-recorded filler: "${audioFile.text}" (${callerType})`);
        
        // Play the audio file directly
        const { getCurrentMediaStream } = require('../server');
        const mediaStream = getCurrentMediaStream();
        
        if (mediaStream) {
          // Notify VAD that assistant is about to start speaking (same as Azure TTS)
          const vadService = require('./vadService');
          if (mediaStream && mediaStream.streamSid) {
            vadService.onAssistantSpeakingStart(mediaStream.streamSid);
          }
          
          // Read audio file and play it
          const audioBuffer = fs.readFileSync(audioFile.filePath);
          await this.playAudioBuffer(audioBuffer, mediaStream);
          
          // Notify VAD that assistant stopped speaking (same as Azure TTS)
          if (mediaStream && mediaStream.streamSid) {
            vadService.onAssistantSpeakingEnd(mediaStream.streamSid);
          }
          
          console.log(`✅ Played pre-recorded audio: ${audioFile.fileName}`);
          return true;
        } else {
          console.log('⚠️ No media stream available for audio playback');
          return false;
        }
      } else {
        console.log(`⚠️ No pre-recorded audio found for: "${fillerText}" (${callerType})`);
        return false;
      }
    } catch (error) {
      console.error('❌ Error playing filler audio:', error);
      return false;
    }
  }

  // Detect customer filler category from filler text
  detectCustomerFillerCategory(text) {
    const lowerText = text.toLowerCase();
    
    // Shift/Cancel appointment scenario
    if (lowerText.includes('pull up') || lowerText.includes('check') || lowerText.includes('looking') || 
        lowerText.includes('reviewing') || lowerText.includes('schedule') || lowerText.includes('appointment')) {
      return 'shift_cancel_appointment';
    }
    // Search/Find/Check scenario  
    else if (lowerText.includes('finding') || lowerText.includes('searching') || lowerText.includes('looking up')) {
      return 'check_find_search';
    }
    // Booking/Creating scenario
    else if (lowerText.includes('set') || lowerText.includes('processing') || lowerText.includes('creating') ||
             lowerText.includes('booking') || lowerText.includes('arranging')) {
      return 'book_schedule_create';
    }
    // General fallback
    else {
      return 'general';
    }
  }

  // Detect category from filler text (for teammate)
  detectCategory(text) {
    const lowerText = text.toLowerCase();
    
    // Tool execution fillers (new categories from generate-tool-fillers.js)
    if (lowerText.includes('calling') || lowerText.includes("i'm calling") || lowerText.includes('call them') ||
        lowerText.includes('connecting') || lowerText.includes('reach out')) {
      return 'tool_calling';
    } else if (lowerText.includes('sending') || lowerText.includes('send that') || lowerText.includes('notification')) {
      return 'tool_sending';
    } else if (lowerText.includes('updating') || lowerText.includes('update that') || lowerText.includes('making those changes')) {
      return 'tool_updating';
    } else if (lowerText.includes('check that') || lowerText.includes('one moment') || lowerText.includes('just a second') ||
               lowerText.includes('analyzing') || lowerText.includes('processing')) {
      return 'tool_processing';
    }
    // Legacy calendar operation fillers
    else if (lowerText.includes('update') || lowerText.includes('save')) {
      return 'calendar_update';
    } else if (lowerText.includes('fetch') || lowerText.includes('pull up')) {
      return 'calendar_fetch';
    } else if (lowerText.includes('appointment') || lowerText.includes('schedule') || lowerText.includes('meeting')) {
      return 'delay_notification';
    }
    
    return null;
  }

  // Play audio buffer through media stream
  async playAudioBuffer(audioBuffer, mediaStream) {
    try {
      // Set up mediaStream for audio playback
      mediaStream.speaking = true;
      mediaStream.ttsStart = Date.now();
      mediaStream.firstByte = true;
      mediaStream.currentMediaStream = mediaStream;
      
      // Check if WebSocket connection is available
      if (!mediaStream.connection) {
        console.log('⚠️ WebSocket connection not available for audio playback');
        mediaStream.speaking = false;
        return;
      }
      
      // Stream audio in chunks (similar to Azure TTS streaming)
      const chunkSize = 1024; // 1KB chunks
      const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
      const chunkDelay = 20; // 20ms between chunks (50 chunks per second)
      
      console.log(`🎵 Streaming ${totalChunks} audio chunks (${audioBuffer.length} bytes total)`);
      
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, audioBuffer.length);
        const chunk = audioBuffer.slice(start, end);
        
        // Convert chunk to base64
        const base64Chunk = chunk.toString('base64');
        
        // Send chunk through WebSocket (same as Azure TTS)
        const actualStreamSid = mediaStream.streamSid || mediaStream.fallbackStreamSid;
        const message = {
          event: 'media',
          streamSid: actualStreamSid,
          media: { payload: base64Chunk }
        };
        
        mediaStream.connection.sendUTF(JSON.stringify(message));
        
        // Add delay between chunks to simulate real-time streaming
        if (i < totalChunks - 1) {
          await new Promise(resolve => setTimeout(resolve, chunkDelay));
        }
      }
      
      // Calculate actual duration based on audio length
      const estimatedDuration = Math.max(1000, audioBuffer.length / 100); // Rough estimate: 100 bytes per ms
      await new Promise(resolve => setTimeout(resolve, estimatedDuration));
      
      mediaStream.speaking = false;
      console.log(`✅ Finished streaming pre-recorded audio (${totalChunks} chunks)`);
      
    } catch (error) {
      console.error('❌ Error playing audio buffer:', error);
      mediaStream.speaking = false;
      
      // Notify VAD that assistant stopped speaking (due to error)
      const vadService = require('./vadService');
      if (mediaStream && mediaStream.streamSid) {
        vadService.onAssistantSpeakingEnd(mediaStream.streamSid);
      }
      
      throw error;
    }
  }

  // Check if audio files are available
  isAudioAvailable() {
    return this.audioIndex !== null && this.audioIndex.totalRecordings > 0;
  }

  // Get statistics about available audio files
  getAudioStats() {
    if (!this.audioIndex) {
      return { available: false, totalRecordings: 0, categories: {} };
    }

    return {
      available: true,
      totalRecordings: this.audioIndex.totalRecordings,
      categories: Object.keys(this.audioIndex.categories).reduce((acc, category) => {
        acc[category] = this.audioIndex.categories[category].length;
        return acc;
      }, {}),
      generatedAt: this.audioIndex.generatedAt
    };
  }
}

module.exports = new FillerAudioService();
