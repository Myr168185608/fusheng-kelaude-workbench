import {isAbsolute} from 'node:path';

// The server, not the caller, decides which Claude config the CLI uses. An inherited terminal,
// a request body, or a shell profile must never override the credentials, provider selection,
// config location, or load arbitrary code into the child process, so those variables are stripped
// from the environment handed to the CLI. Proxy variables are intentionally NOT filtered: the
// operator's own HTTP(S)/ALL/NO_PROXY settings pass through unchanged.
const blocked=/^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|PROFILE|FEDERATION_.*)|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|CLAUDECODE|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP)$/i;
export function claudeEnvironment({env={},configDir}={}) {
  if(configDir!==undefined&&(typeof configDir!=='string'||!isAbsolute(configDir)))throw new TypeError('Config directory must be an absolute path');
  const result=Object.fromEntries(Object.entries({...process.env,...env}).filter(([key,value])=>!blocked.test(key)&&value!==undefined));
  if(configDir!==undefined)result.CLAUDE_CONFIG_DIR=configDir;
  return result;
}
