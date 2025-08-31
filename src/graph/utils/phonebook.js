// Phonebook management utilities
const fs = require('fs');
const path = require('path');

let phonebook = null;

// Load phonebook data
function loadPhonebook() {
  if (!phonebook) {
    try {
      const phonebookPath = path.join(__dirname, '../../../phonebook.json');
      const data = fs.readFileSync(phonebookPath, 'utf8');
      phonebook = JSON.parse(data);
      console.log('📞 Phonebook loaded with', Object.keys(phonebook).length, 'contacts');
    } catch (error) {
      console.error('❌ Error loading phonebook:', error);
      phonebook = {};
    }
  }
  return phonebook;
}

// Function to identify caller from phone number
function identifyCaller(phoneNumber) {
  const contacts = loadPhonebook();
  
  // Try exact match first
  if (contacts[phoneNumber]) {
    return contacts[phoneNumber];
  }
  
  // Try without country code (remove +1 if present)
  const withoutCountryCode = phoneNumber.replace(/^\+1/, '');
  if (contacts[withoutCountryCode]) {
    return contacts[withoutCountryCode];
  }
  
  // Try with +1 prefix if not present
  const withCountryCode = phoneNumber.startsWith('+') ? phoneNumber : `+1${phoneNumber}`;
  if (contacts[withCountryCode]) {
    return contacts[withCountryCode];
  }
  
  // Try different formats
  for (const [number, contact] of Object.entries(contacts)) {
    const cleanNumber = number.replace(/[\s\-\(\)]/g, '');
    const cleanInput = phoneNumber.replace(/[\s\-\(\)]/g, '');
    
    if (cleanNumber.includes(cleanInput) || cleanInput.includes(cleanNumber)) {
      return contact;
    }
  }
  
  return null; // Unknown caller
}

// Utility function to reload phonebook (useful for testing)
function reloadPhonebook() {
  phonebook = null;
  return loadPhonebook();
}

// Utility function to add contact to phonebook
function addContact(phoneNumber, name, type) {
  const contacts = loadPhonebook();
  contacts[phoneNumber] = { name, type };
  
  try {
    const phonebookPath = path.join(__dirname, '../../../phonebook.json');
    fs.writeFileSync(phonebookPath, JSON.stringify(contacts, null, 2));
    console.log(`✅ Added contact: ${name} (${type}) - ${phoneNumber}`);
    return true;
  } catch (error) {
    console.error('❌ Error adding contact:', error);
    return false;
  }
}

module.exports = {
  loadPhonebook,
  identifyCaller,
  reloadPhonebook,
  addContact
};
