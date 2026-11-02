// Loaded before every unit test (node --import): the pure modules read
// their texts through i18n.js, and the tests check the Turkish ones.
import { readFileSync } from 'node:fs';
import { setMessages } from '../../src/lib/i18n.js';

setMessages(JSON.parse(readFileSync(new URL('../../_locales/tr/messages.json', import.meta.url), 'utf8')), 'tr');
