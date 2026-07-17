#!/usr/bin/env node
const args = process.argv.slice(2);
const nameIndex = args.indexOf('--name');
const name = nameIndex !== -1 && args[nameIndex + 1] ? args[nameIndex + 1] : 'World';
console.log(`Thanks, ${name}! Welcome to the external greeting program.`);
