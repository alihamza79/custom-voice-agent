// Quick Demo - Test the New Interruption System
// Run this to see how acknowledgment filtering works

const { InterruptionManager } = require('../src/services/interruptionManager');

const interruptionManager = new InterruptionManager();

// Test cases for different languages and scenarios
const testCases = [
  // English - Should NOT interrupt (acknowledgments)
  { text: "ok", language: "english", expected: false },
  { text: "perfect", language: "english", expected: false },
  { text: "got it", language: "english", expected: false },
  { text: "yes, that's right", language: "english", expected: false },
  
  // Hindi - Should NOT interrupt (acknowledgments) 
  { text: "हाँ", language: "hindi", expected: false },
  { text: "ठीक", language: "hindi", expected: false },
  { text: "बिल्कुल सही", language: "hindi", expected: false },
  { text: "accha", language: "hindi", expected: false },
  { text: "samjh gaya", language: "hindi", expected: false },
  
  // German - Should NOT interrupt (acknowledgments)
  { text: "ja", language: "german", expected: false },
  { text: "genau richtig", language: "german", expected: false },
  { text: "verstehe", language: "german", expected: false },
  
  // Russian - Should NOT interrupt (acknowledgments)
  { text: "да", language: "russian", expected: false },
  { text: "хорошо", language: "russian", expected: false },
  { text: "понятно", language: "russian", expected: false },
  
  // Emergency words - SHOULD interrupt
  { text: "stop", language: "english", expected: true },
  { text: "wait a minute", language: "english", expected: true },
  { text: "रुको", language: "hindi", expected: true },
  { text: "stopp", language: "german", expected: true },
  { text: "стоп", language: "russian", expected: true },
  
  // Intent changes - SHOULD interrupt
  { text: "actually, I want to reschedule", language: "english", expected: true },
  { text: "लेकिन मुझे कुछ और चाहिए", language: "hindi", expected: true },
  { text: "aber ich möchte etwas anderes", language: "german", expected: true }
];

console.log('🧪 Testing Enhanced Interruption System\n');

let passed = 0;
let failed = 0;

testCases.forEach((testCase, index) => {
  const decision = interruptionManager.shouldInterrupt(
    testCase.text, 
    0.85, // High confidence 
    testCase.language,
    { speaking: true }
  );
  
  const result = decision.shouldInterrupt === testCase.expected;
  const status = result ? '✅ PASS' : '❌ FAIL';
  
  console.log(`${(index + 1).toString().padStart(2, ' ')}. ${status} | ${testCase.language.padEnd(7, ' ')} | "${testCase.text}" → ${decision.shouldInterrupt ? 'INTERRUPT' : 'IGNORE'} (${decision.reason})`);
  
  if (result) {
    passed++;
  } else {
    failed++;
    console.log(`    Expected: ${testCase.expected}, Got: ${decision.shouldInterrupt}`);
  }
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? '🎉 All tests passed!' : '⚠️ Some tests failed - check implementation');
