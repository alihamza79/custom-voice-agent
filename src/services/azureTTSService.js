// Azure TTS Service for real-time streaming synthesis
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { AZURE_TTS_CONFIG } = require('../config/constants');
const { SPEECH_KEY, SPEECH_REGION } = require('../config/environment');
const sseService = require('./sseService');
const { getAzureTTSConfig } = require('../utils/languageDetection');
const vadService = require('./vadService');

class AzureTTSService {
  constructor() {
    this.synthesizer = null;
    this.currentSynthesisRequest = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.keepAliveInterval = null;
    this.isReady = false;
  }

  // Initialize Azure TTS with streaming optimization
  async initialize() {
    if (!SPEECH_KEY || !SPEECH_REGION) {
      console.error('Azure TTS Init error: Missing SPEECH_KEY or SPEECH_REGION');
      return false;
    }
    
    try {
      // Create speech configuration
      const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
      
      // Configure for ultra-low latency streaming
      speechConfig.speechSynthesisVoiceName = AZURE_TTS_CONFIG.voiceName;
      speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat[AZURE_TTS_CONFIG.outputFormat];
      
      // Enable real-time streaming for minimal latency
      speechConfig.setProperty(sdk.PropertyId.Speech_StreamingLatency, AZURE_TTS_CONFIG.streamingLatency);
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_SynthEnableCompressedAudioTransmission, "true");
      
      // Optimize for real-time scenarios with streaming
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "3000");
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, "300");
      
      // Enable streaming synthesis
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_SynthStreamChunkSize, "8192");
      
      // Create synthesizer with null audio config for manual streaming handling
      this.synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
      
      this.reconnectAttempts = 0;
      this.isReady = true;
      
      return true;
      
    } catch (error) {
      console.error('Azure TTS Init error:', error);
      this.synthesizer = null;
      this.isReady = false;
      return false;
    }
  }

  // NEW: Real-time Azure TTS Streaming Function with minimal latency and multi-language support
  async synthesizeStreaming(text, mediaStream, language = 'english', retries = 3) {
    // Notify VAD that assistant is about to start speaking
    if (mediaStream && mediaStream.streamSid) {
      vadService.onAssistantSpeakingStart(mediaStream.streamSid);
    }
    
    // Start TTS
    
    if (!this.synthesizer || !this.isReady) {
      if (retries > 0) {
        setTimeout(() => {
          this.initialize();
          this.synthesizeStreaming(text, mediaStream, language, retries - 1);
        }, 1000);
      }
      return false;
    }
    
    // Get language-specific voice configuration
    const ttsConfig = getAzureTTSConfig(language);
    
    if (!text || text.trim().length === 0) {
      return false;
    }

    // Cancel any ongoing synthesis
    if (this.currentSynthesisRequest) {
      try {
        this.currentSynthesisRequest.cancel();
      } catch (e) {
        // Error canceling previous synthesis
      }
    }

    // Create optimized SSML for ultra-low latency with language-specific voice
    const ssml = this.createSSML(text, ttsConfig);

    return new Promise((resolve, reject) => {
      let firstByte = true;
      const ttsStart = Date.now();

      // Setup streaming event handlers for real-time audio delivery
      this.synthesizer.synthesizing = (sender, event) => {
        if (!mediaStream.speaking || !mediaStream.connection) {
          console.log('Azure TTS: Stopping streaming - speaking:', mediaStream.speaking);
          return;
        }

        if (event.result.audioData && event.result.audioData.byteLength > 0) {
          // Convert ArrayBuffer to Buffer for immediate streaming
          const audioChunk = Buffer.from(event.result.audioData);
          
          // Mark first byte timing for minimal latency measurement
          if (firstByte) {
            const end = Date.now();
            const duration = end - ttsStart;
            console.log(`Azure TTS: First streaming audio in ${duration}ms`);
            firstByte = false;
            if (mediaStream.sendFirstSentenceInputTime) {
              console.log(`Azure TTS: End-of-sentence to streaming audio: ${end - mediaStream.sendFirstSentenceInputTime}ms`);
            }
            try { 
              sseService.broadcast('tts_first_byte_ms', { ms: duration }); 
            } catch (_) {}
          }
          
          // Send audio chunk immediately to Twilio (no artificial chunking delay)
          const payload = audioChunk.toString('base64');
          const actualStreamSid = mediaStream.streamSid || mediaStream.fallbackStreamSid;
          const message = {
            event: 'media',
            streamSid: actualStreamSid,
            media: { payload },
          };
          
          mediaStream.connection.sendUTF(JSON.stringify(message));
          // console.log(`Azure TTS: Streamed ${audioChunk.length} bytes in real-time`);
        }
      };

      // Handle synthesis completion
      this.synthesizer.synthesizeCompleted = (sender, event) => {
        if (event.result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          console.log('Azure TTS: Real-time streaming synthesis completed');
          mediaStream.speaking = false;
          this.currentSynthesisRequest = null;
          resolve(true);
        } else {
          console.error('Azure TTS: Streaming synthesis failed:', event.result.errorDetails);
          mediaStream.speaking = false;
          this.currentSynthesisRequest = null;
          
          // Retry with exponential backoff
          if (retries > 0) {
            const delay = (4 - retries) * 1000; // 1s, 2s, 3s delays
            console.log(`Azure TTS: Retrying streaming in ${delay}ms (${retries} attempts left)`);
            setTimeout(() => this.synthesizeStreaming(text, mediaStream, language, retries - 1), delay);
          } else {
            reject(new Error(event.result.errorDetails));
          }
        }
      };

      // Handle synthesis cancellation
      this.synthesizer.synthesizeCanceled = (sender, event) => {
        console.log('Azure TTS: Synthesis canceled:', event.result.errorDetails || 'User interrupted');
        mediaStream.speaking = false;
        this.currentSynthesisRequest = null;
        resolve(false);
      };

      // Start real-time synthesis with streaming events
      try {
        this.currentSynthesisRequest = this.synthesizer.speakSsmlAsync(
          ssml,
          (result) => {
            // This callback is for final completion, streaming happens in synthesizing event
            console.log('Azure TTS: Final synthesis callback completed');
            this.currentSynthesisRequest = null;
            
            // Notify VAD that assistant stopped speaking
            if (mediaStream && mediaStream.streamSid) {
              vadService.onAssistantSpeakingEnd(mediaStream.streamSid);
            }
          },
          (error) => {
            console.error('Azure TTS: Streaming synthesis error:', error);
            mediaStream.speaking = false;
            this.currentSynthesisRequest = null;
            
            // Notify VAD that assistant stopped speaking (due to error)
            if (mediaStream && mediaStream.streamSid) {
              vadService.onAssistantSpeakingEnd(mediaStream.streamSid);
            }
            
            // Retry on error
            if (retries > 0) {
              const delay = (4 - retries) * 1000;
              console.log(`Azure TTS: Retrying streaming after error in ${delay}ms`);
              setTimeout(() => this.synthesizeStreaming(text, mediaStream, language, retries - 1), delay);
            } else {
              reject(error);
            }
          }
        );
      } catch (error) {
        console.error('Azure TTS: Failed to start streaming synthesis:', error);
        mediaStream.speaking = false;
        this.currentSynthesisRequest = null;
        reject(error);
      }
    });
  }

  // Create optimized SSML for synthesis with language support
  createSSML(text, ttsConfig = null) {
    const config = ttsConfig || {
      voice: AZURE_TTS_CONFIG.voiceName,
      locale: 'en-US'
    };
    
    const escapedText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    return `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${config.locale}">
        <voice name="${config.voice}">
          <prosody rate="${AZURE_TTS_CONFIG.prosodyRate}" pitch="${AZURE_TTS_CONFIG.prosodyPitch}">
            ${escapedText}
          </prosody>
        </voice>
      </speak>`;
  }

  // Cancel current synthesis
  cancelCurrentSynthesis(streamSid = null) {
    if (this.currentSynthesisRequest) {
      try {
        this.currentSynthesisRequest.cancel();
        console.log('Azure TTS: Current synthesis canceled');
        
        // Notify VAD that assistant stopped speaking (due to cancellation)
        if (streamSid) {
          vadService.onAssistantSpeakingEnd(streamSid);
        }
      } catch (e) {
        console.warn('Azure TTS: Error canceling synthesis:', e);
      }
      this.currentSynthesisRequest = null;
    }
  }

  // Check if service is ready
  isServiceReady() {
    return this.isReady && this.synthesizer !== null;
  }

  // Cleanup resources
  cleanup() {
    this.cancelCurrentSynthesis();
    
    if (this.synthesizer) {
      try {
        this.synthesizer.close();
      } catch (e) {
        console.warn('Azure TTS: Error closing synthesizer:', e);
      }
      this.synthesizer = null;
    }
    
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    
    this.isReady = false;
    console.log('Azure TTS: Service cleaned up');
  }
}

// Export singleton instance
module.exports = new AzureTTSService();
