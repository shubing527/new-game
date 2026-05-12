// Server-side question bank module (CommonJS).
// 內容依據：Chemistry LibreTexts (Ions in Solution; Electrolytes and Nonelectrolytes);
// Siyavula Grade 10 Physical Sciences。 50 題，繁體中文。
// Source: adapted from electrolyte-snake/questions.js
const path = require('path');
const fs = require('fs');

// We mimic the browser shape by evaluating the original file in a sandbox.
const src = fs.readFileSync(path.join(__dirname, 'questions-source.js'), 'utf8');
const sandbox = { window: {} };
const vm = require('vm');
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const QUESTION_BANK = sandbox.window.QUESTION_BANK || [];

module.exports = { QUESTION_BANK };
