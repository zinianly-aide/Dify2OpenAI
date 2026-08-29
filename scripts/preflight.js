const required = ['DIFY_API_URL', 'DIFY_API_KEY'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.log(`preflight: BLOCKED - missing ${missing.join(', ')}`);
  process.exitCode = 2;
} else {
  try { new URL(process.env.DIFY_API_URL); console.log('preflight: PASS - Dify integration environment configured'); }
  catch { console.log('preflight: BLOCKED - DIFY_API_URL is invalid'); process.exitCode = 2; }
}
