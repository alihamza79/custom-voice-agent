// Performance tracking utilities
const { CHARS_TO_CHECK } = require('../config/constants');

function containsAnyChars(str) {
  // Convert the string to an array of characters
  let strArray = Array.from(str);
  
  // Check if any character in strArray exists in chars_to_check
  return strArray.some(char => CHARS_TO_CHECK.includes(char));
}

module.exports = {
  containsAnyChars
};
