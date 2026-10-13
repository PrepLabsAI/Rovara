/** This source is written to a private mount and executed only by the pinned container image. */
export const FIXED_CANDIDATE_BOOTSTRAP = String.raw`
import { pathToFileURL } from 'node:url';
let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, chunk]);
  if (input.length > 262144) process.exit(71);
}
const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
const frame = JSON.parse(text);
if (!frame || typeof frame !== 'object' || typeof frame.requestId !== 'string' || !Object.hasOwn(frame, 'input')) process.exit(72);
const entry = process.env.AGENTX_ENTRY;
if (!entry || !entry.startsWith('/candidate/') || entry !== entry.normalize('NFC') || [...entry].length > 252 || [...entry].some((character) => { const code = character.codePointAt(0); return code < 32 || code === 127; })) process.exit(73);
const relative = entry.slice('/candidate/'.length);
const segments = relative.split('/');
if (!relative.endsWith('.mjs') || relative.includes('\\') || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment === '.git' || segment === '.env')) process.exit(73);
const loaded = await import(pathToFileURL(entry).href);
if (typeof loaded.default !== 'function') process.exit(74);
const value = await loaded.default(frame.input);
const response = JSON.stringify({ requestId: frame.requestId, output: value });
if (Buffer.byteLength(response, 'utf8') > 262144) process.exit(75);
process.stdout.write(response + '\n');
`;
