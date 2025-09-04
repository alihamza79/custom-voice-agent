// Concurrency Test Script - Test multiple simultaneous calls
// This script simulates concurrent callers to verify session isolation

const WebSocket = require('ws');
const { performance } = require('perf_hooks');

class ConcurrencyTester {
  constructor() {
    this.testResults = [];
    this.activeConnections = [];
  }

  // Simulate a single caller
  async simulateCaller(callerNumber, callDuration = 30000) {
    return new Promise((resolve, reject) => {
      const startTime = performance.now();
      const ws = new WebSocket('ws://localhost:5000/');
      
      const testData = {
        callerNumber,
        startTime,
        events: [],
        sessionId: null,
        errors: []
      };

      ws.on('open', () => {
        console.log(`📞 Caller ${callerNumber}: Connected`);
        testData.events.push({ type: 'connected', time: performance.now() - startTime });

        // Simulate Twilio start event
        const startEvent = {
          event: "start",
          start: {
            streamSid: `stream_${callerNumber}_${Date.now()}`,
            callSid: `call_${callerNumber}_${Date.now()}`,
            accountSid: "test_account",
            customParameters: {
              callerNumber: callerNumber
            }
          }
        };
        
        ws.send(JSON.stringify(startEvent));
        testData.sessionId = startEvent.start.streamSid;

        // Simulate some speech after a delay
        setTimeout(() => {
          console.log(`🗣️ Caller ${callerNumber}: Speaking...`);
          testData.events.push({ type: 'speech_start', time: performance.now() - startTime });
          
          // Simulate different types of requests
          const requests = [
            "Hello, I want to shift my appointment",
            "Hi, can you check my appointments please?", 
            "I need to cancel my dental appointment"
          ];
          
          const randomRequest = requests[Math.floor(Math.random() * requests.length)];
          
          // Simulate speech final event
          const speechEvent = {
            event: "media",
            media: {
              track: "inbound",
              payload: Buffer.from("fake_audio_data").toString('base64')
            }
          };
          
          ws.send(JSON.stringify(speechEvent));
          testData.events.push({ 
            type: 'request_sent', 
            request: randomRequest, 
            time: performance.now() - startTime 
          });

        }, 2000 + Math.random() * 3000); // Random delay 2-5 seconds
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          testData.events.push({ 
            type: 'response_received', 
            event: message.event,
            time: performance.now() - startTime 
          });
          
          if (message.event === 'media') {
            console.log(`🔊 Caller ${callerNumber}: Received audio response`);
          }
        } catch (e) {
          console.error(`❌ Caller ${callerNumber}: Error parsing message:`, e);
        }
      });

      ws.on('error', (error) => {
        console.error(`❌ Caller ${callerNumber}: WebSocket error:`, error);
        testData.errors.push({ error: error.message, time: performance.now() - startTime });
      });

      ws.on('close', () => {
        const endTime = performance.now() - startTime;
        console.log(`📴 Caller ${callerNumber}: Disconnected after ${endTime}ms`);
        testData.events.push({ type: 'disconnected', time: endTime });
        testData.totalDuration = endTime;
        
        this.testResults.push(testData);
        resolve(testData);
      });

      // Store connection for cleanup
      this.activeConnections.push({ ws, callerNumber, startTime });

      // Auto-disconnect after specified duration
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log(`⏰ Caller ${callerNumber}: Auto-disconnect`);
          ws.close();
        }
      }, callDuration);
    });
  }

  // Run concurrency test with multiple simultaneous callers
  async runConcurrencyTest(numCallers = 5, callDuration = 30000) {
    console.log(`🚀 Starting concurrency test with ${numCallers} simultaneous callers`);
    
    const callerPromises = [];
    for (let i = 0; i < numCallers; i++) {
      const callerNumber = `+155512300${i.toString().padStart(2, '0')}`;
      
      // Stagger connections slightly to simulate real-world timing
      const delay = i * 500; // 500ms between each caller
      
      const promise = new Promise(resolve => {
        setTimeout(async () => {
          try {
            const result = await this.simulateCaller(callerNumber, callDuration);
            resolve(result);
          } catch (error) {
            console.error(`❌ Caller ${callerNumber} failed:`, error);
            resolve({ callerNumber, error: error.message });
          }
        }, delay);
      });
      
      callerPromises.push(promise);
    }

    // Wait for all callers to complete
    console.log(`⏳ Waiting for all ${numCallers} callers to complete...`);
    const results = await Promise.all(callerPromises);
    
    // Analyze results
    this.analyzeResults(results);
    
    return results;
  }

  // Analyze test results for concurrency issues
  analyzeResults(results) {
    console.log('\n📊 === CONCURRENCY TEST RESULTS ===\n');
    
    const successfulCalls = results.filter(r => !r.error);
    const failedCalls = results.filter(r => r.error);
    
    console.log(`✅ Successful calls: ${successfulCalls.length}`);
    console.log(`❌ Failed calls: ${failedCalls.length}`);
    
    if (failedCalls.length > 0) {
      console.log('\n❌ FAILED CALLS:');
      failedCalls.forEach(call => {
        console.log(`  • ${call.callerNumber}: ${call.error}`);
      });
    }
    
    if (successfulCalls.length > 0) {
      console.log('\n⏱️ TIMING ANALYSIS:');
      const avgDuration = successfulCalls.reduce((sum, call) => sum + call.totalDuration, 0) / successfulCalls.length;
      const minDuration = Math.min(...successfulCalls.map(call => call.totalDuration));
      const maxDuration = Math.max(...successfulCalls.map(call => call.totalDuration));
      
      console.log(`  • Average call duration: ${avgDuration.toFixed(0)}ms`);
      console.log(`  • Shortest call: ${minDuration.toFixed(0)}ms`);
      console.log(`  • Longest call: ${maxDuration.toFixed(0)}ms`);
      
      // Check for session isolation
      console.log('\n🔍 SESSION ISOLATION CHECK:');
      const uniqueSessions = new Set(successfulCalls.map(call => call.sessionId).filter(Boolean));
      console.log(`  • Unique session IDs: ${uniqueSessions.size}/${successfulCalls.length}`);
      
      if (uniqueSessions.size === successfulCalls.length) {
        console.log('  ✅ Session isolation working correctly');
      } else {
        console.log('  ❌ Session isolation FAILED - sessions are being shared!');
      }
    }
    
    console.log('\n📋 DETAILED RESULTS:');
    results.forEach((result, index) => {
      if (result.error) {
        console.log(`${index + 1}. ${result.callerNumber}: FAILED - ${result.error}`);
      } else {
        console.log(`${index + 1}. ${result.callerNumber}: SUCCESS - ${result.totalDuration.toFixed(0)}ms, ${result.events.length} events`);
      }
    });
  }

  // Clean up all active connections
  cleanup() {
    this.activeConnections.forEach(({ ws, callerNumber }) => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log(`🧹 Cleaning up caller ${callerNumber}`);
        ws.close();
      }
    });
    this.activeConnections = [];
  }
}

// Export for use in tests
module.exports = ConcurrencyTester;

// Run test if called directly
if (require.main === module) {
  const tester = new ConcurrencyTester();
  
  console.log('🧪 Starting Voice Agent Concurrency Test');
  console.log('Make sure your server is running on http://localhost:5000\n');
  
  tester.runConcurrencyTest(3, 20000) // 3 callers, 20 seconds each
    .then((results) => {
      console.log('\n✅ Test completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Test failed:', error);
      process.exit(1);
    })
    .finally(() => {
      tester.cleanup();
    });
}
