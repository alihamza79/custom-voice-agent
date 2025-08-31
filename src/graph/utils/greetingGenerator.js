// Greeting generation utilities using OpenAI
const OpenAI = require('openai');

const openai = new OpenAI();

// Generate personalized greeting using OpenAI LLM with language support
async function generatePersonalizedGreeting(callerInfo, phoneNumber, language = 'english') {
  try {
    let systemPrompt = '';
    let userPrompt = '';
    
    // Language-specific prompts
    const languageInstructions = {
      english: "Respond in English",
      german: "Respond in German (Deutsch)",
      hindi: "Respond in Hindi (हिंदी)",
      hindi_mixed: "Respond in Hindi with some English words mixed in naturally (Hinglish style), as is common in Indian conversation"
    };
    
    const languageInstruction = languageInstructions[language] || languageInstructions.english;
    
    if (callerInfo) {
      // Known caller
      systemPrompt = `You are a professional voice assistant. A caller has just connected and you need to greet them warmly and personally. Keep the greeting brief, friendly, and professional. ${languageInstruction}.`;
      
      userPrompt = `Generate a personalized greeting for ${callerInfo.name} who is calling. Their role/relationship is: ${callerInfo.type}. 
      
      Guidelines:
      - Keep it brief (1-2 sentences max)
      - Be warm and welcoming
      - Use their name
      - Adjust tone based on their relationship type:
        * customer: Professional and helpful
        * boss: Respectful and attentive  
        * teammate: Friendly and collaborative
      - End by asking how you can help them
      - Do NOT mention the phone number
      - ${languageInstruction}
      
      Examples for English:
      - "Hello John! Great to hear from you. How can I assist you today?"
      - "Good day Sarah! I'm ready to help. What can I do for you?"
      - "Hi Mike! Hope you're doing well. How can I help you today?"`;
      
    } else {
      // Unknown caller
      systemPrompt = `You are a professional voice assistant. An unknown caller has just connected and you need to provide a friendly, professional greeting. ${languageInstruction}.`;
      
      userPrompt = `Generate a professional greeting for an unknown caller from phone number ${phoneNumber}.
      
      Guidelines:
      - Keep it brief (1-2 sentences max)
      - Be polite and professional
      - Welcome them warmly
      - Ask how you can help them
      - Do NOT mention that they are unknown or unrecognized
      - ${languageInstruction}
      
      Example for English:
      - "Hello! Welcome, and thank you for calling. How can I assist you today?"`;
    }
    
    // SPEED OPTIMIZED: Parallel processing + reduced tokens for sub-2sec latency
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.3, // Lower for consistency and speed
      max_tokens: 50,   // Much smaller for faster generation
      stream: false     // Disable streaming for faster completion
    });
    
    const greeting = completion.choices[0].message.content.trim();
    console.log(`🤖 Generated greeting for ${callerInfo ? callerInfo.name : 'unknown caller'}:`, greeting);
    
    return greeting;
    
  } catch (error) {
    console.error('❌ Error generating greeting with OpenAI:', error);
    
    // Fallback greeting
    if (callerInfo) {
      return `Hello ${callerInfo.name}! How can I help you today?`;
    } else {
      return "Hello! Thank you for calling. How can I assist you today?";
    }
  }
}

module.exports = {
  generatePersonalizedGreeting
};
