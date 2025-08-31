// WhatsApp Notification Service using Twilio
const twilio = require('twilio');
const OpenAI = require('openai');

const openai = new OpenAI();

class WhatsAppService {
  constructor() {
    // Initialize Twilio client (will use same credentials as voice)
    this.client = null;
    this.initialized = false;
  }

  // Initialize WhatsApp service
  async initialize() {
    try {
      const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
      
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        console.log('⚠️  WhatsApp service: Twilio credentials not found, using mock mode');
        this.client = { mock: true };
        this.initialized = true;
        return true;
      }
      
      this.client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      this.initialized = true;
      console.log('✅ WhatsApp service initialized with real Twilio API');
      return true;
      
    } catch (error) {
      console.error('❌ Failed to initialize WhatsApp service:', error);
      // Don't fall back to mock - show the error
      throw error;
    }
  }

  // Send WhatsApp notification to team member
  async notifyTeamMember(phoneNumber, message) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      if (this.client.mock) {
        console.log('📱 [MOCK] WhatsApp to team member:', {
          to: phoneNumber,
          message: message
        });
        return { success: true, mock: true };
      }

      // Format WhatsApp number (must include whatsapp: prefix)
      const whatsappNumber = `whatsapp:${phoneNumber}`;
      const fromNumber = 'whatsapp:+14155238886'; // Twilio WhatsApp sandbox number

      const messageResponse = await this.client.messages.create({
        body: message,
        from: fromNumber,
        to: whatsappNumber
      });

      console.log('✅ WhatsApp sent to team member:', {
        to: phoneNumber,
        messageId: messageResponse.sid
      });

      return { success: true, messageId: messageResponse.sid };

    } catch (error) {
      console.error('❌ Failed to send WhatsApp to team member:', error);
      return { success: false, error: error.message };
    }
  }

  // Send WhatsApp notification to office
  async notifyOffice(message, appointmentDetails = null) {
    try {
      const officeNumbers = [
        '+1234567890', // Main office
        '+1234567891'  // Manager
      ];

      const results = [];
      
      for (const number of officeNumbers) {
        const result = await this.notifyTeamMember(number, message);
        results.push({ number, result });
      }

      return results;

    } catch (error) {
      console.error('❌ Failed to send WhatsApp to office:', error);
      return [{ error: error.message }];
    }
  }

  // Generate intelligent WhatsApp notification using LLM
  async generateAppointmentNotification(callerInfo, appointmentDetails, requestType, teamMemberRole) {
    try {
      console.log('🧠 Generating intelligent WhatsApp message with LLM...');
      
      const { name, phoneNumber } = callerInfo;
      const timestamp = new Date().toLocaleString();
      
      let appointmentsText = '';
      if (appointmentDetails && appointmentDetails.length > 0) {
        appointmentsText = appointmentDetails.map((apt, index) => {
          const date = new Date(apt.start.dateTime).toLocaleDateString();
          const time = new Date(apt.start.dateTime).toLocaleTimeString();
          return `${index + 1}. ${apt.summary} - ${date} at ${time}`;
        }).join('\n');
      } else {
        appointmentsText = 'No appointments found in system';
      }
      
      const systemPrompt = `Generate a professional WhatsApp notification for a ${teamMemberRole} about a customer appointment request.

CONTEXT:
- Customer: ${name}
- Phone: ${phoneNumber}
- Request: ${requestType} appointment
- Time: ${timestamp}
- Appointments found: ${appointmentDetails?.length || 0}

APPOINTMENTS:
${appointmentsText}

REQUIREMENTS:
- Professional but friendly tone
- Include relevant emojis
- Clear action required
- Under 200 characters for WhatsApp
- Include customer contact info
- Urgency appropriate for ${teamMemberRole}

Generate the WhatsApp message:`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: systemPrompt }],
        temperature: 0.3, // More consistent for professional messages
        max_tokens: 150
      });

      const message = completion.choices[0].message.content.trim();
      console.log('✅ LLM generated WhatsApp notification');
      return message;
      
    } catch (error) {
      console.error('❌ LLM WhatsApp generation failed:', error);
      // Fallback to simple message
      return this.getFallbackWhatsAppMessage(callerInfo, appointmentDetails, requestType);
    }
  }

  // Simple fallback WhatsApp message
  getFallbackWhatsAppMessage(callerInfo, appointmentDetails, requestType) {
    const { name, phoneNumber } = callerInfo;
    return `🔔 ${requestType.toUpperCase()} Request\n👤 ${name} (${phoneNumber})\n📅 ${appointmentDetails?.length || 0} appointments\n💬 Please follow up ASAP`;
  }

  // Send comprehensive appointment notification
  async sendAppointmentNotification(callerInfo, appointmentDetails, requestType) {
    try {
      console.log('📱 Sending intelligent WhatsApp notifications...');

      // Get team member numbers from phonebook
      const teamMembers = await this.getTeamMemberNumbers();
      
      // Send personalized messages to each team member
      const teamResults = [];
      for (const member of teamMembers) {
        // Generate personalized message for each team member role
        const personalizedMessage = await this.generateAppointmentNotification(
          callerInfo, 
          appointmentDetails, 
          requestType,
          member.role || 'team member'
        );
        
        const result = await this.notifyTeamMember(member.number, personalizedMessage);
        teamResults.push({ 
          member: member.name, 
          role: member.role,
          result 
        });
        
        console.log(`📱 Sent to ${member.name} (${member.role}):`, personalizedMessage.substring(0, 50) + '...');
      }

      console.log('✅ WhatsApp notifications sent:', {
        teamMembers: teamResults.length,
        successCount: teamResults.filter(r => r.result.success).length
      });

      return {
        success: true,
        teamResults,
        totalSent: teamResults.length
      };

    } catch (error) {
      console.error('❌ Failed to send appointment notifications:', error);
      return { success: false, error: error.message };
    }
  }

  // Get team member numbers from phonebook
  async getTeamMemberNumbers() {
    try {
      const { loadPhonebook } = require('../graph/utils/phonebook');
      const phonebook = await loadPhonebook();
      
      // Filter team members (teammates, boss, office)
      const teamMembers = Object.entries(phonebook)
        .filter(([number, info]) => ['teammate', 'boss', 'office'].includes(info.type))
        .map(([number, info]) => ({
          name: info.name,
          number: number,
          role: info.type
        }));

      console.log(`📞 Found ${teamMembers.length} team members for notifications`);
      return teamMembers;

    } catch (error) {
      console.error('❌ Error loading team members:', error);
      return [];
    }
  }
}

module.exports = new WhatsAppService();
