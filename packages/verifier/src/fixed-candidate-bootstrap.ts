/** Fixed adapter executed by the pinned container; candidate exports stay ordinary modules. */
export const FIXED_CANDIDATE_BOOTSTRAP = String.raw`
import { pathToFileURL } from 'node:url';
let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, chunk]);
  if (input.length > 262144) process.exit(71);
}
const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
const frame = JSON.parse(text);
if (!frame || typeof frame !== 'object' || Array.isArray(frame) || Object.keys(frame).length !== 2 || !Object.hasOwn(frame, 'wireId') || !Object.hasOwn(frame, 'input') || typeof frame.wireId !== 'string' || !/^[a-f0-9]{48}$/.test(frame.wireId)) process.exit(72);
const serialize = JSON.stringify.bind(JSON);
const writeResponse = process.stdout.write.bind(process.stdout);
const entry = process.env.AGENTX_ENTRY;
const exportName = process.env.AGENTX_EXPORT;
if (!entry || !entry.startsWith('/candidate/') || entry !== entry.normalize('NFC') || [...entry].length > 252 || [...entry].some((character) => { const code = character.codePointAt(0); return code < 32 || code === 127; })) process.exit(73);
const relative = entry.slice('/candidate/'.length);
const segments = relative.split('/');
if (!relative.endsWith('.mjs') || relative.includes('\\') || segments.some((segment) => { const key = segment.normalize('NFKC').toLowerCase(); return !segment || segment === '.' || segment === '..' || key.startsWith('.env') || key === '.git' || key === '.ssh' || key === '.aws' || key === '.docker'; })) process.exit(73);
if (typeof exportName !== 'string' || !/^(default|[A-Za-z_$][A-Za-z0-9_$]{0,63})$/.test(exportName)) process.exit(73);
const loaded = await import(pathToFileURL(entry).href);
const candidate = loaded[exportName];
if (typeof candidate !== 'function') process.exit(74);
const value = await candidate(frame.input);
const response = serialize({ wireId: frame.wireId, output: value });
if (Buffer.byteLength(response, 'utf8') > 262143) process.exit(75);
writeResponse(response + '\n');
`;
